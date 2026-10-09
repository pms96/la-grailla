import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { runMigrationsForAll, runMigrationsForSubscription, listLocalMigrations, frontPrismaDir, hardProblems } from '@/lib/services/migrations';
import { createTenant } from '@/lib/services/tenants';
import { childEnv } from '@/lib/migrations/executor';
import { setRegistryStoreForTests } from '@/lib/registry/store';
import type { RegistryStore } from '@/lib/registry/store';
import { verifyDomainManually } from '@/lib/services/domains';
import { publishSubscription } from '@/lib/services/snapshot';
import { ForbiddenError } from '@/lib/permissions';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';
import { createScratchDb, dropScratchDb, makeFixturePrismaDir, queryScratch } from './scratch-db';

const DBS = ['lagrailla_scratch_mig_a', 'lagrailla_scratch_mig_b', 'lagrailla_scratch_mig_c'] as const;
const urls: Record<string, string> = {};

// Fechas posteriores a la línea base del linter, para que SÍ se revisen.
const M1 = '20270101000000_crea_tabla';
const M2 = '20270101000100_anade_columna';
const GOOD = { [M1]: 'CREATE TABLE "demo" ("id" INTEGER PRIMARY KEY);', [M2]: 'ALTER TABLE "demo" ADD COLUMN "nota" TEXT;' };

async function tenantOn(dbName: string, over: Record<string, unknown> = {}) {
  const { actor } = await makeOperator('SUPERADMIN');
  const { subscription, tenant } = await createTenant(tenantInput({ dbUrlPooled: urls[dbName], dbUrlDirect: urls[dbName], ...over }) as never, actor);
  return { actor, subscription, tenant };
}

beforeAll(async () => {
  for (const name of DBS) urls[name] = await createScratchDb(name);
});
afterAll(async () => {
  for (const name of DBS) await dropScratchDb(name);
});
beforeEach(async () => {
  await resetControlDb();
  freshStore();
  // BDs limpias en cada test.
  for (const name of DBS) urls[name] = await createScratchDb(name);
});

describe('runner de migraciones — un cliente', () => {
  it('aplica lo pendiente, registra la ejecución, actualiza schemaVersion y es idempotente', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[0]);

    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(res).toMatchObject({ status: 'SUCCEEDED', fromVersion: null, toVersion: M2, pending: [M1, M2], attempts: 1, error: null });

    const cols = await queryScratch<{ column_name: string }>(DBS[0], `SELECT column_name FROM information_schema.columns WHERE table_name = 'demo' ORDER BY 1`);
    expect(cols.map((c) => c.column_name)).toEqual(['id', 'nota']);
    expect((await prisma.subscription.findUnique({ where: { id: subscription.id } }))!.schemaVersion).toBe(M2);

    const again = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(again).toMatchObject({ status: 'SUCCEEDED', fromVersion: M2, toVersion: M2, pending: [], attempts: 0 });
    expect(await prisma.migrationRun.count({ where: { subscriptionId: subscription.id } })).toBe(2);

    const audit = await prisma.auditLog.findMany({ where: { tenantId: subscription.tenantId, action: 'migration.run' } });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit.map((a) => a.meta))).not.toMatch(/postgres/);
  });

  it('--dry-run lista lo pendiente y no toca la BD', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[0]);
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, dryRun: true });
    expect(res).toMatchObject({ status: 'SUCCEEDED', dryRun: true, pending: [M1, M2] });
    const tables = await queryScratch(DBS[0], `SELECT table_name FROM information_schema.tables WHERE table_name IN ('demo', '_prisma_migrations')`);
    expect(tables).toHaveLength(0);
    expect((await prisma.subscription.findUnique({ where: { id: subscription.id } }))!.schemaVersion).toBeNull();
  });

  it('el linter rechaza una migración destructiva y no se aplica NADA, salvo allowDestructive', async () => {
    const dir = makeFixturePrismaDir({ ...GOOD, '20270101000200_borra': 'ALTER TABLE "demo" DROP COLUMN "nota";' });
    const { actor, subscription } = await tenantOn(DBS[0]);
    const blocked = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(blocked.status).toBe('FAILED');
    expect(blocked.error).toMatch(/drop-column/);
    expect(await queryScratch(DBS[0], `SELECT 1 FROM information_schema.tables WHERE table_name = 'demo'`)).toHaveLength(0);

    const forced = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, allowDestructive: true, republish: false });
    expect(forced.status).toBe('SUCCEEDED');
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: subscription.tenantId, action: 'migration.run' }, orderBy: { id: 'desc' } });
    expect((audit!.meta as { allowDestructive: boolean }).allowDestructive).toBe(true);
  });

  it('un fallo real queda a la vista, no se reintenta, y la siguiente ejecución exige intervención humana', async () => {
    const dir = makeFixturePrismaDir({ [M1]: 'CREATE TABLE "demo" ("id" INTEGER PRIMARY KEY);', [M2]: 'ALTER TABLE "no_existe" ADD COLUMN "x" TEXT;' });
    const { actor, subscription } = await tenantOn(DBS[0]);
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(res.status).toBe('FAILED');
    expect(res.attempts).toBe(1);
    expect(res.error).toMatch(/no_existe|P3018/);
    expect(res.error).not.toMatch(/postgres(ql)?:\/\//);
    // La primera migración sí quedó aplicada; la versión registrada NO avanza a una migración que falló.
    expect((await prisma.subscription.findUnique({ where: { id: subscription.id } }))!.schemaVersion).toBeNull();

    const next = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(next.status).toBe('FAILED');
    expect(next.error).toMatch(/fallidas sin resolver/);
  });

  it('un bloqueo (lock_timeout) deshace la migración, se reintenta y termina', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[0]);
    // Estado previo: M1 ya aplicada, M2 pendiente (necesita ACCESS EXCLUSIVE sobre "demo").
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: makeFixturePrismaDir({ [M1]: GOOD[M1] }), republish: false });

    // Otra conexión mantiene un bloqueo sobre "demo" hasta que el runner duerme entre intentos.
    const holder = new PrismaClient({ datasourceUrl: urls[DBS[0]], log: [] });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holding = holder.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "demo" IN ACCESS SHARE MODE');
      await held;
    }, { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 400));

    let sleeps = 0;
    const res = await runMigrationsForSubscription(subscription.id, actor, {
      prismaDir: dir,
      republish: false,
      lockTimeoutMs: 800,
      sleep: async () => {
        sleeps += 1;
        release(); // el bloqueo desaparece antes del 2.º intento
        await holding;
      },
    });
    await holder.$disconnect();

    expect(res).toMatchObject({ status: 'SUCCEEDED', attempts: 2, toVersion: M2 });
    expect(sleeps).toBe(1);
    const cols = await queryScratch<{ column_name: string }>(DBS[0], `SELECT column_name FROM information_schema.columns WHERE table_name = 'demo' ORDER BY 1`);
    expect(cols.map((c) => c.column_name)).toEqual(['id', 'nota']);
    // La BD no ha tenido nunca un lock_timeout propio (iba solo en la conexión del runner).
    expect(await queryScratch(DBS[0], `SELECT 1 FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setconfig::text LIKE '%lock_timeout%'`)).toHaveLength(0);
  });

  it('si el bloqueo no cede, se rinde tras los intentos con un mensaje claro y deja la BD intacta', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[0]);
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: makeFixturePrismaDir({ [M1]: GOOD[M1] }), republish: false });

    const holder = new PrismaClient({ datasourceUrl: urls[DBS[0]], log: [] });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holding = holder.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "demo" IN ACCESS SHARE MODE');
      await held;
    }, { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 400));

    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false, lockTimeoutMs: 500, maxAttempts: 2, sleep: async () => {} });
    release();
    await holding;
    await holder.$disconnect();

    expect(res.status).toBe('FAILED');
    expect(res.attempts).toBe(2);
    expect(res.error).toMatch(/lock_timeout/);
    // Recuperable: sin bloqueo, la siguiente ejecución sí termina (la migración abortada se marcó como revertida).
    const retry = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(retry.status).toBe('SUCCEEDED');
  });

  it('no deja correr dos ejecuciones a la vez sobre el mismo cliente', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[0]);
    await prisma.migrationRun.create({ data: { subscriptionId: subscription.id, tenantId: subscription.tenantId, triggeredBy: 'otro', status: 'RUNNING' } });
    await expect(runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir })).rejects.toThrow(/en curso/);
  });

  it('una ejecución «en curso» abandonada hace tiempo se da por muerta', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[0]);
    const old = await prisma.migrationRun.create({
      data: { subscriptionId: subscription.id, tenantId: subscription.tenantId, triggeredBy: 'otro', status: 'RUNNING', startedAt: new Date(Date.now() - 2 * 3_600_000) },
    });
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(res.status).toBe('SUCCEEDED');
    expect((await prisma.migrationRun.findUnique({ where: { id: old.id } }))!.status).toBe('FAILED');
  });

  it('exige permiso: un VIEWER no puede migrar', async () => {
    const { subscription } = await tenantOn(DBS[0]);
    const { actor: viewer } = await makeOperator('VIEWER');
    await expect(runMigrationsForSubscription(subscription.id, viewer, { prismaDir: makeFixturePrismaDir(GOOD) })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('tras migrar republica el registro con la nueva schemaVersion (si ya estaba publicado)', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const store = freshStore();
    const { actor, subscription } = await tenantOn(DBS[0]);
    const { verifyDomainManually } = await import('@/lib/services/domains');
    const { publishSubscription } = await import('@/lib/services/snapshot');
    const domain = await prisma.domain.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    await verifyDomainManually(domain.id, actor);
    await publishSubscription(subscription.id, actor, store);
    const seqBefore = (await prisma.subscription.findUnique({ where: { id: subscription.id } }))!.snapshotSeq;

    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir });
    expect(res.status).toBe('SUCCEEDED');
    expect(res.warnings).toEqual([]);
    const after = (await prisma.subscription.findUnique({ where: { id: subscription.id } }))!;
    expect(after.snapshotSeq).toBeGreaterThan(seqBefore);
    expect(after.schemaVersion).toBe(M2);
  });
});

describe('runner de migraciones — arreglos de la revisión', () => {
  it('BD ya al día y registro sin versión: el runner SINCRONIZA el registro (si no, el cliente queda en mantenimiento)', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const store = freshStore();
    const { actor, subscription } = await tenantOn(DBS[0]);
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    const domain = await prisma.domain.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    await verifyDomainManually(domain.id, actor);
    await prisma.subscription.update({ where: { id: subscription.id }, data: { schemaVersion: null } });
    await publishSubscription(subscription.id, actor, store);
    const seq = (await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).snapshotSeq;

    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir });
    expect(res).toMatchObject({ status: 'SUCCEEDED', pending: [], republishFailed: false });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.schemaVersion).toBe(M2);
    expect(after.snapshotSeq).toBeGreaterThan(seq); // republicado con la versión nueva

    // Ya sincronizado: otra pasada no vuelve a publicar.
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).snapshotSeq).toBe(after.snapshotSeq);
  });

  it('un dry-run NO sincroniza el registro', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[0]);
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    await prisma.subscription.update({ where: { id: subscription.id }, data: { schemaVersion: null } });
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, dryRun: true });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).schemaVersion).toBeNull();
  });

  it('si no se puede republicar, el resultado lo marca (el script sale con error)', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[0]);
    const domain = await prisma.domain.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    await verifyDomainManually(domain.id, actor);
    await publishSubscription(subscription.id, actor, freshStore());
    const failing: RegistryStore = { put: async () => { throw new Error('registro caído'); }, get: async () => null, del: async () => {} } as unknown as RegistryStore;
    setRegistryStoreForTests(failing);
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir });
    expect(res.status).toBe('SUCCEEDED');
    expect(res.republishFailed).toBe(true);
    expect(res.warnings.join()).toMatch(/no se pudo republicar/);
  });

  it('el marcador `-- allow-destructive:` NO basta para aplicar una destructiva a todos los clientes: hace falta la bandera', async () => {
    const dir = makeFixturePrismaDir({ ...GOOD, '20270101000200_borra': '-- allow-destructive: revisada en el PR\nALTER TABLE "demo" DROP COLUMN "nota";' });
    const { actor, subscription } = await tenantOn(DBS[0]);
    const blocked = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(blocked.status).toBe('FAILED');
    expect(blocked.error).toMatch(/drop-column/);
    expect((await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, allowDestructive: true, republish: false })).status).toBe('SUCCEEDED');
  });

  it('transacciones explícitas y CONCURRENTLY nunca se aplican, ni con allowDestructive', async () => {
    expect(hardProblems('BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;')[0]).toMatch(/explicit-tx/);
    expect(hardProblems('CREATE INDEX CONCURRENTLY i ON a (id);')[0]).toMatch(/concurrently/);
    expect(hardProblems('-- BEGIN en un comentario\nCREATE TABLE a (id int);')).toEqual([]);
    expect(hardProblems('CREATE TABLE "begin_log" (id int);')).toEqual([]);

    const dir = makeFixturePrismaDir({ '20270101000000_tx': 'BEGIN;\nCREATE TABLE "demo" ("id" INTEGER);\nCOMMIT;' });
    const { actor, subscription } = await tenantOn(DBS[0]);
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, allowDestructive: true, republish: false });
    expect(res.status).toBe('FAILED');
    expect(res.error).toMatch(/explicit-tx/);
    expect(await queryScratch(DBS[0], `SELECT 1 FROM information_schema.tables WHERE table_name = 'demo'`)).toHaveLength(0);
  });

  it('plan B (ALTER DATABASE): un lock_timeout residual de un runner que murió NO se vuelve permanente', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[0]);
    // Como si un runner anterior hubiera muerto entre el ALTER y el RESET:
    await queryScratch(DBS[0], `ALTER DATABASE "${DBS[0]}" SET lock_timeout = '3000ms'`);
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false, lockTimeoutMs: 3000, lockTimeoutMode: 'database' });
    expect(res.status).toBe('SUCCEEDED');
    expect(await queryScratch(DBS[0], `SELECT 1 FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setconfig::text LIKE '%lock_timeout%'`)).toHaveLength(0);
  });

  it('plan B (ALTER DATABASE): un lock_timeout propio de la BD (distinto del nuestro) se restaura al terminar', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenantOn(DBS[1]);
    await queryScratch(DBS[1], `ALTER DATABASE "${DBS[1]}" SET lock_timeout = '9000ms'`);
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false, lockTimeoutMode: 'database' });
    const rows = await queryScratch<{ setconfig: string[] }>(DBS[1], `SELECT setconfig FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    expect(rows[0].setconfig).toContain('lock_timeout=9000ms');
  });

  it('un bloque DO $$ BEGIN … END $$ no cuenta como transacción explícita, pero un COMMIT suelto sí', () => {
    expect(hardProblems(`DO $$\nBEGIN\n  PERFORM 1;\nEND\n$$;`)).toEqual([]);
    expect(hardProblems(`CREATE FUNCTION f() RETURNS int AS $body$\nBEGIN\n RETURN 1;\nEND;\n$body$ LANGUAGE plpgsql;`)).toEqual([]);
    expect(hardProblems(`DO $$ BEGIN PERFORM 1; END $$;\nCOMMIT;`).join(' ')).toContain('explicit-tx');
    expect(hardProblems(`BEGIN;\nALTER TABLE a ADD COLUMN b INT;\nCOMMIT;`).join(' ')).toContain('explicit-tx');
  });

  it('el proceso de prisma NO hereda las claves del panel (solo una lista blanca)', () => {
    const env = childEnv('postgresql://u:p@h/db', { PATH: '/bin', HOME: '/h', SECRETS_KEYS: '{"m":"x"}', CONTROL_DATABASE_URL: 'postgresql://control', PANEL_CRON_SECRET: 's', PLATFORM_CRON_MASTER: 'm', SNAPSHOT_SIGNING_KEY: 'k', PRISMA_ENGINES_MIRROR: 'https://mirror', HTTPS_PROXY: 'http://p' } as unknown as NodeJS.ProcessEnv);
    expect(Object.keys(env).sort()).toEqual(['CHECKPOINT_DISABLE', 'DATABASE_URL', 'DIRECT_URL', 'HOME', 'HTTPS_PROXY', 'PATH', 'PRISMA_ENGINES_MIRROR', 'PRISMA_HIDE_UPDATE_MESSAGE']);
  });
});

describe('runner de migraciones — en lote', () => {
  it('migra todos los clientes activos y deja un registro por cliente', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const a = await tenantOn(DBS[0]);
    const b = await tenantOn(DBS[1]);
    const out = await runMigrationsForAll(a.actor, { prismaDir: dir, republish: false, concurrency: 2 });
    expect(out.failed).toBe(0);
    expect(out.results.map((r) => r.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    for (const name of [DBS[0], DBS[1]]) {
      expect(await queryScratch(name, `SELECT 1 FROM information_schema.columns WHERE table_name = 'demo' AND column_name = 'nota'`)).toHaveLength(1);
    }
    expect(b.subscription.id).toBeTruthy();
  });

  it('PARA ante el primer fallo: los clientes que no llegaron a lanzarse quedan SKIPPED y no se tocan', async () => {
    const dir = makeFixturePrismaDir({ [M1]: 'ALTER TABLE "no_existe" ADD COLUMN "x" TEXT;' });
    const bad = await tenantOn(DBS[0]);
    const next = await tenantOn(DBS[1]);
    const out = await runMigrationsForAll(bad.actor, { prismaDir: dir, republish: false, concurrency: 1 });
    const byId = new Map(out.results.map((r) => [r.subscriptionId, r]));
    expect(byId.get(bad.subscription.id)!.status).toBe('FAILED');
    expect(byId.get(next.subscription.id)!.status).toBe('SKIPPED');
    expect(out).toMatchObject({ failed: 1, skipped: 1, stoppedEarly: true });
    expect(await queryScratch(DBS[1], `SELECT 1 FROM information_schema.tables WHERE table_name = '_prisma_migrations'`)).toHaveLength(0);
  });

  it('los canarios van primero y, si fallan, no se toca a nadie más', async () => {
    const dir = makeFixturePrismaDir({ [M1]: 'ALTER TABLE "no_existe" ADD COLUMN "x" TEXT;' });
    const first = await tenantOn(DBS[0]);
    const canary = await tenantOn(DBS[1]);
    const out = await runMigrationsForAll(first.actor, { prismaDir: dir, republish: false, canary: [canary.subscription.id], concurrency: 3 });
    expect(out.results[0].subscriptionId).toBe(canary.subscription.id);
    expect(out.results[0].status).toBe('FAILED');
    expect(out.results.find((r) => r.subscriptionId === first.subscription.id)!.status).toBe('SKIPPED');
  });

  it('no migra clientes en borrado ni los que no se piden con `only`', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const a = await tenantOn(DBS[0]);
    const b = await tenantOn(DBS[1]);
    const c = await tenantOn(DBS[2]);
    await prisma.tenant.update({ where: { id: c.tenant.id }, data: { status: 'PENDING_DELETION' } });
    const out = await runMigrationsForAll(a.actor, { prismaDir: dir, republish: false, only: [a.subscription.id, c.subscription.id] });
    expect(out.results.map((r) => r.subscriptionId)).toEqual([a.subscription.id]);
    expect(b.subscription.id).not.toBe(a.subscription.id);
  });
});

describe('migraciones reales del front', () => {
  it('las migraciones del repo se aplican de cero sobre una BD vacía y dejan la última como versión', async () => {
    const { actor, subscription } = await tenantOn(DBS[2]);
    const local = listLocalMigrations(frontPrismaDir());
    expect(fs.existsSync(frontPrismaDir())).toBe(true);
    const res = await runMigrationsForSubscription(subscription.id, actor, { republish: false });
    expect(res.error).toBeNull();
    expect(res.status).toBe('SUCCEEDED');
    expect(res.toVersion).toBe(local[local.length - 1]);
    expect(await queryScratch(DBS[2], `SELECT 1 FROM information_schema.tables WHERE table_name = 'AppConfig'`)).toHaveLength(1);
  }, 120_000);
});
