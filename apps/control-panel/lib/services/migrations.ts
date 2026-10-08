import fs from 'node:fs';
import path from 'node:path';
import type { MigrationRun, MigrationRunStatus } from '@prisma/client';
import { migrationStamp } from '@grailla/contracts';
// El linter de migraciones es el mismo que usa la CI del front: lo que el runner se niega a aplicar es lo que la CI ya rechaza.
import { BASELINE_MIGRATION, lintMigrationSql } from '../../../../scripts/migration-lint';
import type { ActingOperator } from '../actor';
import { appendAudit } from '../audit';
import { prisma } from '../db';
import { prismaExecutor, redactUrls, type MigrationExecutor } from '../migrations/executor';
import { assertCan } from '../permissions';
import { openField } from '../secrets-store';
import { ServiceError } from './errors';
import { publishSubscription } from './snapshot';
import { DB_URL_DIRECT_FIELD } from './tenants';

/* Runner de migraciones (M7). Aplica las migraciones del front a la BD de cada cliente, de una en una o en lote, y deja constancia en
 * `MigrationRun`. Corre como TRABAJO EXTERNO (script/CI), nunca dentro de una petición ni del build del front.
 *
 * Reglas (del plan):
 *  - solo migraciones aditivas (el linter las rechaza si no, salvo `allowDestructive` explícito);
 *  - `lock_timeout` de 3 s y reintentos: una migración que espera un bloqueo no deja en cola el tráfico del cliente;
 *  - concurrencia limitada y PARADA ante el primer fallo (los que no llegan a lanzarse quedan como SKIPPED);
 *  - un fallo que no es de bloqueo no se «arregla» solo: queda la migración fallida a la vista para una persona;
 *  - al terminar, el registro de enrutado se actualiza con la nueva `schemaVersion` y se republica, y el front ya puede servir al cliente
 *    con el código que la exige (FRONT_MIN_SCHEMA).
 *  - no hay «down»: se corrige hacia delante y se restaura (PITR) antes de cualquier «contract». */

export const MIGRATION_LOCK_TIMEOUT_MS = 3_000;
export const MIGRATION_MAX_ATTEMPTS = 3;
/** Una ejecución «en curso» más vieja que esto se da por abandonada (el proceso murió). */
export const RUN_STALE_MS = 30 * 60_000;

export function frontPrismaDir(): string {
  return path.resolve(process.env.FRONT_PRISMA_DIR || path.join(process.cwd(), '..', '..', 'prisma'));
}

export function listLocalMigrations(prismaDir: string = frontPrismaDir()): string[] {
  const dir = path.join(prismaDir, 'migrations');
  return fs
    .readdirSync(dir)
    .filter((n) => migrationStamp(n) !== null && fs.statSync(path.join(dir, n)).isDirectory())
    .sort();
}

export type RunOptions = {
  dryRun?: boolean;
  /** Aplicar aunque el linter vea algo destructivo (queda en la auditoría). */
  allowDestructive?: boolean;
  maxAttempts?: number;
  lockTimeoutMs?: number;
  /** Carpeta `prisma/` del front (con `schema.prisma` y `migrations/`). */
  prismaDir?: string;
  executor?: MigrationExecutor;
  sleep?: (ms: number) => Promise<void>;
  /** Republicar el registro tras migrar (por defecto, sí). */
  republish?: boolean;
};

export type MigrationRunResult = {
  runId: string;
  subscriptionId: string;
  tenantId: string;
  status: MigrationRunStatus;
  dryRun: boolean;
  fromVersion: string | null;
  toVersion: string | null;
  pending: string[];
  attempts: number;
  error: string | null;
  warnings: string[];
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const last = (names: string[]) => [...names].sort().pop() ?? null;

function toResult(run: MigrationRun, warnings: string[] = []): MigrationRunResult {
  return {
    runId: run.id,
    subscriptionId: run.subscriptionId,
    tenantId: run.tenantId,
    status: run.status,
    dryRun: run.dryRun,
    fromVersion: run.fromVersion,
    toVersion: run.toVersion,
    pending: run.pending,
    attempts: run.attempts,
    error: run.error,
    warnings,
  };
}

/** Reserva la ejecución: dos runners a la vez sobre el mismo cliente se pisarían. */
async function reserveRun(subscriptionId: string, tenantId: string, dryRun: boolean, actor: ActingOperator): Promise<MigrationRun> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`migrate:${subscriptionId}`}))`;
    const running = await tx.migrationRun.findFirst({ where: { subscriptionId, status: 'RUNNING' }, orderBy: { startedAt: 'desc' } });
    if (running) {
      if (Date.now() - running.startedAt.getTime() < RUN_STALE_MS) {
        throw new ServiceError('migration_in_progress', 'Ya hay una ejecución de migraciones en curso para este cliente');
      }
      await tx.migrationRun.update({
        where: { id: running.id },
        data: { status: 'FAILED', finishedAt: new Date(), error: 'Abandonada: el proceso no terminó' },
      });
    }
    return tx.migrationRun.create({ data: { subscriptionId, tenantId, dryRun, triggeredBy: actor.email, status: 'RUNNING' } });
  });
}

async function finish(runId: string, data: Partial<Pick<MigrationRun, 'status' | 'toVersion' | 'pending' | 'attempts' | 'error' | 'fromVersion'>>): Promise<MigrationRun> {
  return prisma.migrationRun.update({ where: { id: runId }, data: { ...data, finishedAt: new Date() } });
}

/** Aplica (o simula) las migraciones pendientes en UN cliente. No lanza por fallos de migración: devuelve el resultado. */
export async function runMigrationsForSubscription(subscriptionId: string, actor: ActingOperator, opts: RunOptions = {}): Promise<MigrationRunResult> {
  assertCan(actor.role, 'migrations:run');
  const executor = opts.executor ?? prismaExecutor;
  const sleep = opts.sleep ?? defaultSleep;
  const prismaDir = opts.prismaDir ?? frontPrismaDir();
  const dryRun = !!opts.dryRun;
  const maxAttempts = opts.maxAttempts ?? MIGRATION_MAX_ATTEMPTS;

  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { tenant: true } });
  if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
  if (sub.tenant.status === 'PENDING_DELETION' || sub.tenant.status === 'DELETED') {
    throw new ServiceError('invalid_state', 'Este cliente está en borrado: no se migra');
  }
  const run = await reserveRun(subscriptionId, sub.tenantId, dryRun, actor);
  const warnings: string[] = [];

  const fail = async (error: string, extra: Parameters<typeof finish>[1] = {}) => {
    const done = await finish(run.id, { status: 'FAILED', error: redactUrls(error).slice(0, 1500), ...extra });
    await audit(done);
    return toResult(done, warnings);
  };
  const audit = async (r: MigrationRun) => {
    await prisma.$transaction((tx) =>
      appendAudit(tx, {
        actor,
        action: r.status === 'FAILED' ? 'migration.failed' : dryRun ? 'migration.dry_run' : 'migration.run',
        targetType: 'subscription',
        targetId: subscriptionId,
        tenantId: sub.tenantId,
        meta: { runId: r.id, status: r.status, from: r.fromVersion, to: r.toVersion, pending: r.pending, attempts: r.attempts, allowDestructive: !!opts.allowDestructive, error: r.error ? r.error.slice(0, 200) : null },
      })
    );
  };

  try {
    const directUrl = await openField(sub.dbUrlDirectEnc, { scope: sub.tenantId, field: DB_URL_DIRECT_FIELD });
    const schemaPath = path.join(prismaDir, 'schema.prisma');
    const local = listLocalMigrations(prismaDir);
    const before = await executor.inspect(directUrl);
    const fromVersion = last(before.applied);
    const pending = local.filter((m) => !before.applied.includes(m));
    const ahead = before.applied.filter((m) => !local.includes(m));
    if (ahead.length) warnings.push(`La BD tiene migraciones que este código no conoce: ${ahead.join(', ')}`);

    if (before.failed.length) {
      return await fail(`Hay migraciones fallidas sin resolver (${before.failed.join(', ')}): una persona debe revisarlas y marcarlas con \`prisma migrate resolve\` antes de seguir`, { fromVersion, pending });
    }

    if (!opts.allowDestructive) {
      const dir = path.join(prismaDir, 'migrations');
      const problems = pending
        .filter((name) => name > BASELINE_MIGRATION)
        .flatMap((name) => {
          const file = path.join(dir, name, 'migration.sql');
          return fs.existsSync(file) ? lintMigrationSql(fs.readFileSync(file, 'utf8')).map((f) => `${name}: [${f.rule}] ${f.message}`) : [];
        });
      if (problems.length) return await fail(`El linter rechaza migraciones pendientes (no se aplica nada):\n${problems.join('\n')}`, { fromVersion, pending });
    }

    if (dryRun || pending.length === 0) {
      const done = await finish(run.id, { status: 'SUCCEEDED', fromVersion, toVersion: fromVersion, pending, attempts: 0 });
      await audit(done);
      return toResult(done, warnings);
    }

    // Aplicar con lock_timeout y reintentos solo si lo que falló fue el bloqueo (la migración se deshizo entera).
    let attempts = 0;
    let lastError = '';
    let applied = false;
    await executor.withLockTimeout(directUrl, opts.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS, async () => {
      while (attempts < maxAttempts) {
        attempts += 1;
        const outcome = await executor.deploy(directUrl, { schemaPath });
        if (outcome.ok) {
          applied = true;
          return;
        }
        lastError = outcome.message;
        if (outcome.kind !== 'lock_timeout' || !outcome.migration) return; // fallo real: se queda a la vista
        await executor.resolveRolledBack(directUrl, outcome.migration, { schemaPath });
        if (attempts < maxAttempts) await sleep(Math.min(30_000, 1_000 * 2 ** (attempts - 1)) + Math.floor(Math.random() * 250));
      }
    });
    if (!applied) {
      return await fail(attempts >= maxAttempts && /55P03/.test(lastError) ? `Bloqueo de la BD tras ${attempts} intentos (lock_timeout): reintenta fuera de las horas de venta` : lastError || 'La migración falló', {
        fromVersion,
        pending,
        attempts,
      });
    }

    const after = await executor.inspect(directUrl);
    const missing = pending.filter((m) => !after.applied.includes(m));
    if (missing.length) return await fail(`Tras migrar siguen sin aplicarse: ${missing.join(', ')}`, { fromVersion, pending, attempts });
    const toVersion = last(after.applied);
    const done = await finish(run.id, { status: 'SUCCEEDED', fromVersion, toVersion, pending, attempts });
    await prisma.subscription.update({ where: { id: subscriptionId }, data: { schemaVersion: toVersion } });
    await audit(done);

    if (opts.republish !== false && sub.lastPublishedAt) {
      try {
        await publishSubscription(subscriptionId, actor);
      } catch (err) {
        warnings.push(`Migrado, pero no se pudo republicar el registro: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return toResult(done, warnings);
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err));
  }
}

export type BatchOptions = RunOptions & {
  concurrency?: number;
  /** Suscripciones a migrar (por defecto, todas las de clientes activos o suspendidos). */
  only?: string[];
  /** Estas se migran primero, una a una; si alguna falla, no se toca a nadie más. */
  canary?: string[];
  stopOnFailure?: boolean;
};

export type BatchResult = { results: MigrationRunResult[]; failed: number; skipped: number; stoppedEarly: boolean };

/** Migra varios clientes con concurrencia limitada (5 por defecto) y parada ante el primer fallo. */
export async function runMigrationsForAll(actor: ActingOperator, opts: BatchOptions = {}): Promise<BatchResult> {
  assertCan(actor.role, 'migrations:run');
  const concurrency = Math.min(10, Math.max(1, opts.concurrency ?? 5));
  const stopOnFailure = opts.stopOnFailure !== false;
  const subs = await prisma.subscription.findMany({
    where: { tenant: { status: { in: ['ACTIVE', 'SUSPENDED'] } }, ...(opts.only ? { id: { in: opts.only } } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true, tenantId: true },
  });
  const canary = (opts.canary ?? []).filter((id) => subs.some((s) => s.id === id));
  const ordered = [...canary.map((id) => subs.find((s) => s.id === id)!), ...subs.filter((s) => !canary.includes(s.id))];

  const results: MigrationRunResult[] = [];
  let stop = false;
  const runOne = async (s: { id: string; tenantId: string }) => {
    if (stop) {
      const skipped = await prisma.migrationRun.create({
        data: { subscriptionId: s.id, tenantId: s.tenantId, status: 'SKIPPED', dryRun: !!opts.dryRun, triggeredBy: actor.email, finishedAt: new Date(), error: 'No lanzado: falló otro cliente antes' },
      });
      results.push(toResult(skipped));
      return;
    }
    let res: MigrationRunResult;
    try {
      res = await runMigrationsForSubscription(s.id, actor, opts);
    } catch (err) {
      // «En curso» u otro error de servicio: cuenta como fallo de ese cliente, sin tumbar el lote.
      const failed = await prisma.migrationRun.create({
        data: { subscriptionId: s.id, tenantId: s.tenantId, status: 'FAILED', dryRun: !!opts.dryRun, triggeredBy: actor.email, finishedAt: new Date(), error: err instanceof Error ? err.message : String(err) },
      });
      res = toResult(failed);
    }
    results.push(res);
    if (res.status === 'FAILED' && stopOnFailure) stop = true;
  };

  // Canarios: en serie y antes que nadie.
  for (const id of canary) await runOne(ordered.find((s) => s.id === id)!);
  const rest = ordered.filter((s) => !canary.includes(s.id));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rest.length) }, async () => {
      while (next < rest.length) await runOne(rest[next++]);
    })
  );
  return {
    results,
    failed: results.filter((r) => r.status === 'FAILED').length,
    skipped: results.filter((r) => r.status === 'SKIPPED').length,
    stoppedEarly: stop,
  };
}
