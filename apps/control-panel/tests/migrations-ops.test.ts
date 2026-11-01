import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateMasterKey } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import type { Alert } from '@/lib/services/alerts';
import { assessSubscription, healthOverview } from '@/lib/queries';
import { prismaExecutor, type MigrationExecutor } from '@/lib/migrations/executor';
import { IN_REQUEST_MIGRATION_BUDGET_MS, RUN_STALE_MS, runMigrationsForAll, runMigrationsForSubscription } from '@/lib/services/migrations';
import { verifyDomainManually } from '@/lib/services/domains';
import { publishSubscription } from '@/lib/services/snapshot';
import { createTenant } from '@/lib/services/tenants';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';
import { createScratchDb, dropScratchDb, makeFixturePrismaDir } from './scratch-db';

process.env.PLATFORM_CRON_MASTER = generateMasterKey();

/* Lote 9 · H-121 y H-122: lo que Salud enseña de las migraciones y lo que pasa cuando una migración se corta a medias dentro de una petición. */

const sent: Alert[] = [];
vi.mock('@/lib/services/alerts', async (original) => ({ ...(await original<typeof import('@/lib/services/alerts')>()), notify: vi.fn(async (a: Alert) => void sent.push(a)) }));

const DB = 'lagrailla_scratch_migops_a';
let url: string;
const M1 = '20270101000000_crea_tabla';
const GOOD = { [M1]: 'CREATE TABLE "demo" ("id" INTEGER PRIMARY KEY);' };

async function tenant() {
  const { actor } = await makeOperator('SUPERADMIN');
  const created = await createTenant(tenantInput({ dbUrlPooled: url, dbUrlDirect: url }) as never, actor);
  return { actor, subscription: created.subscription, tenant: created.tenant, domain: created.domain };
}

beforeAll(async () => {
  url = await createScratchDb(DB);
});
afterAll(async () => dropScratchDb(DB));
beforeEach(async () => {
  await resetControlDb();
  freshStore();
  sent.length = 0;
  url = await createScratchDb(DB);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** Un ejecutor de pega: lo que `deploy` devuelva en cada intento, y lo que se le pidió. */
function fakeExecutor(outcomes: Awaited<ReturnType<MigrationExecutor['deploy']>>[]): MigrationExecutor & { asked: (number | undefined)[]; resolved: string[] } {
  const asked: (number | undefined)[] = [];
  const resolved: string[] = [];
  let i = 0;
  return {
    asked,
    resolved,
    inspect: async () => ({ applied: [], failed: [] }),
    deploy: async (_u, o) => {
      asked.push(o.timeoutMs);
      return outcomes[Math.min(i++, outcomes.length - 1)];
    },
    resolveRolledBack: async (_u, m) => void resolved.push(m),
    withLockTimeout: async (_u, _ms, fn) => fn(),
  };
}

describe('H-122: una migración que no cabe en la petición se corta Y SE ANOTA', () => {
  it('el tope de la petición es de 270 s (la función dura 300)', () => {
    expect(IN_REQUEST_MIGRATION_BUDGET_MS).toBe(270_000);
  });

  it('el motor recibe lo que queda del presupuesto; si se corta por tiempo queda FAILED con instrucciones, sin reintentar, y AVISA', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenant();
    const ex = fakeExecutor([{ ok: false, kind: 'timeout', migration: M1, message: 'cortado' }]);
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false, executor: ex, timeBudgetMs: 60_000 });
    expect(res.status).toBe('FAILED');
    expect(res.attempts).toBe(1); // un corte por tiempo no se reintenta
    expect(res.error).toMatch(/se cortó por tiempo/);
    expect(res.error).toMatch(/migrate resolve/);
    expect(res.error).toMatch(/migrate:tenants/);
    expect(ex.asked).toHaveLength(1);
    expect(ex.asked[0]).toBeLessThanOrEqual(60_000);
    expect(ex.asked[0]).toBeGreaterThan(55_000);
    expect(ex.resolved).toEqual([]); // no se marca como revertida: puede estar a medias
    expect(sent.filter((a) => a.severity === 'critical')).toHaveLength(1);
    expect((await prisma.migrationRun.findFirstOrThrow({ where: { subscriptionId: subscription.id } })).status).toBe('FAILED'); // no se queda «en curso»
  });

  it('sin presupuesto (el script externo) no se pasa tope al motor', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenant();
    const ex = fakeExecutor([{ ok: true }]);
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false, executor: ex });
    expect(ex.asked).toEqual([undefined]);
  });

  it('el presupuesto cuenta TODOS los intentos: tras un lock_timeout y una espera que se lo come, no se lanza otro intento y se anota el corte', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenant();
    const ex = fakeExecutor([{ ok: false, kind: 'lock_timeout', migration: M1, message: '55P03' }, { ok: true }]);
    const res = await runMigrationsForSubscription(subscription.id, actor, {
      prismaDir: dir,
      republish: false,
      executor: ex,
      timeBudgetMs: 1_500,
      sleep: async () => new Promise((r) => setTimeout(r, 1_200)),
    });
    expect(res.status).toBe('FAILED');
    expect(res.error).toMatch(/se cortó por tiempo/);
    expect(ex.asked).toHaveLength(1); // el segundo intento no llegó a lanzarse
  });

  it('el ejecutor real corta el proceso de Prisma al pasar el tope y lo dice (`timeout`)', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const out = await prismaExecutor.deploy(url, { schemaPath: path.join(dir, 'schema.prisma'), timeoutMs: 50 });
    expect(out).toMatchObject({ ok: false, kind: 'timeout' });
  }, 60_000);

  it('una ejecución anterior «en curso» abandonada se da por fallida CON aviso y rastro en la auditoría (antes, en silencio)', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenant();
    const old = await prisma.migrationRun.create({ data: { subscriptionId: subscription.id, tenantId: subscription.tenantId, triggeredBy: 'otro', status: 'RUNNING', startedAt: new Date(Date.now() - RUN_STALE_MS - 60_000) } });
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(res.status).toBe('SUCCEEDED');
    expect(res.warnings.join()).toMatch(/quedó sin terminar/);
    expect(sent.some((a) => a.severity === 'critical' && /quedó sin terminar/.test(a.title))).toBe(true);
    expect(await prisma.auditLog.count({ where: { tenantId: subscription.tenantId, action: 'migration.abandoned' } })).toBe(1);
    expect((await prisma.migrationRun.findUniqueOrThrow({ where: { id: old.id } })).error).toMatch(/Abandonada/);
  });

  it('un ENSAYO abandonado no avisa (no tocó nada)', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenant();
    await prisma.migrationRun.create({ data: { subscriptionId: subscription.id, tenantId: subscription.tenantId, triggeredBy: 'otro', status: 'RUNNING', dryRun: true, startedAt: new Date(Date.now() - RUN_STALE_MS - 60_000) } });
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false });
    expect(sent).toEqual([]);
  });

  it('en lote, un cliente que no se puede ni lanzar («ya hay una ejecución en curso») AVISA como fallo; en ensayo no', async () => {
    const dir = makeFixturePrismaDir(GOOD);
    const { actor, subscription } = await tenant();
    await prisma.migrationRun.create({ data: { subscriptionId: subscription.id, tenantId: subscription.tenantId, triggeredBy: 'otro', status: 'RUNNING' } });
    const out = await runMigrationsForAll(actor, { prismaDir: dir, republish: false, only: [subscription.id] });
    expect(out).toMatchObject({ failed: 1 });
    expect(sent.filter((a) => a.severity === 'critical' && /no se pudo migrar/.test(a.title))).toHaveLength(1);
    sent.length = 0;
    await runMigrationsForAll(actor, { prismaDir: dir, republish: false, only: [subscription.id], dryRun: true });
    expect(sent).toEqual([]);
  });
});

describe('H-121: Salud enseña las migraciones omitidas y no deja que un ensayo oculte un fallo', () => {
  const NOW = Date.parse('2026-11-01T12:00:00Z');
  const base = { published: true, publishedAt: new Date(NOW - 3_600_000), health: { checkedAt: new Date(NOW - 60_000), ok: true, status: 'ok', error: null }, crons: [] };

  it('SKIPPED (venta en marcha o lote parado): aviso ámbar con el motivo', () => {
    const r = assessSubscription({ ...base, lastMigration: { status: 'SKIPPED', error: 'Venta en marcha (40 pedidos en los últimos 15 min)' } }, NOW);
    expect(r.level).toBe('warn');
    expect(r.problems.join()).toMatch(/NO se aplicó.*Venta en marcha/);
  });

  it('SUCCEEDED no genera problema', () => {
    expect(assessSubscription({ ...base, lastMigration: { status: 'SUCCEEDED', error: null } }, NOW)).toMatchObject({ level: 'ok', problems: [] });
  });

  it('«en curso» desde hace más de 30 min es fallo (el proceso murió); reciente, no', () => {
    const at = (min: number) => new Date(NOW - min * 60_000);
    const old = assessSubscription({ ...base, lastMigration: { status: 'RUNNING', error: null, startedAt: at(45) } }, NOW);
    expect(old.level).toBe('bad');
    expect(old.problems.join()).toMatch(/en curso.*30 min/);
    expect(assessSubscription({ ...base, lastMigration: { status: 'RUNNING', error: null, startedAt: at(5) } }, NOW).level).toBe('ok');
  });

  it('con datos reales: un ensayo posterior NO oculta el FALLO de una ejecución real, y un SKIPPED real se ve', async () => {
    const { actor, subscription, tenant: t, domain } = await tenant();
    await verifyDomainManually(domain.id, actor);
    await publishSubscription(subscription.id, actor, freshStore());
    await prisma.tenantHealth.create({ data: { subscriptionId: subscription.id, checkedAt: new Date(), ok: true, status: 'ok' } });
    const run = (data: Record<string, unknown>) => prisma.migrationRun.create({ data: { subscriptionId: subscription.id, tenantId: t.id, triggeredBy: 'x', finishedAt: new Date(), ...data } as never });
    await run({ status: 'FAILED', error: 'P3018 algo falló', startedAt: new Date(Date.now() - 3_600_000) });
    await run({ status: 'SUCCEEDED', dryRun: true, startedAt: new Date(Date.now() - 60_000) }); // un ensayo posterior
    const rows = await healthOverview();
    const row = rows.find((r) => r.subscriptionId === subscription.id)!;
    expect(row.level).toBe('bad');
    expect(row.problems.join()).toMatch(/última migración falló/);

    await run({ status: 'SKIPPED', error: 'No lanzado: falló otro cliente antes', startedAt: new Date() });
    const after = (await healthOverview()).find((r) => r.subscriptionId === subscription.id)!;
    expect(after.problems.join()).toMatch(/NO se aplicó.*falló otro cliente/);
  });
});

describe('H-122: los llamadores que corren DENTRO de una petición pasan el tope de tiempo', () => {
  const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('el botón «Migrar BD» (lifecycle) y el alta (provision) usan IN_REQUEST_MIGRATION_BUDGET_MS; el script externo (migrate-tenants) no lleva tope', () => {
    expect(src('lib/services/lifecycle.ts')).toMatch(/runMigrationsForSubscription\(subscriptionId, actor, \{[^}]*timeBudgetMs: IN_REQUEST_MIGRATION_BUDGET_MS/);
    expect(src('lib/services/provision.ts')).toMatch(/timeBudgetMs: IN_REQUEST_MIGRATION_BUDGET_MS, \.\.\.deps\.migrate/);
    expect(src('scripts/migrate-tenants.ts')).not.toMatch(/timeBudgetMs/);
  });
});

