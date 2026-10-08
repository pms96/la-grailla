import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { HEALTH_STALE_MS, PUBLISH_STALE_MS, assessSubscription, healthOverview } from '@/lib/queries';
import { probeTenantHealth } from '@/lib/services/health';
import { verifyDomainManually } from '@/lib/services/domains';
import { publishSubscription } from '@/lib/services/snapshot';
import { generateMasterKey } from '@grailla/contracts';
import { freshStore, makeOperator, resetControlDb, rootCreateTenant } from './helpers';

process.env.PLATFORM_CRON_MASTER = generateMasterKey();
const NOW = 1_800_000_000_000;
const fresh = new Date(NOW - 60_000);
const base = { published: true, publishedAt: new Date(NOW - 3_600_000), health: { checkedAt: fresh, ok: true, status: 'ok', error: null }, crons: [], lastMigration: null };

describe('assessSubscription', () => {
  it('todo bien', () => expect(assessSubscription(base, NOW)).toEqual({ level: 'ok', problems: [] }));

  it('sin publicar: sin datos, no es un fallo', () => {
    expect(assessSubscription({ ...base, published: false }, NOW).level).toBe('unknown');
  });

  it('no responde = falla; degradado = atención; comprobación antigua = atención', () => {
    expect(assessSubscription({ ...base, health: { ...base.health, ok: false, status: 'unreachable', error: 'timeout' } }, NOW).level).toBe('bad');
    expect(assessSubscription({ ...base, health: { ...base.health, ok: false, status: 'degraded', error: 'Esquema atrasado' } }, NOW).level).toBe('warn');
    const stale = assessSubscription({ ...base, health: { ...base.health, checkedAt: new Date(NOW - HEALTH_STALE_MS - 1) } }, NOW);
    expect(stale.level).toBe('warn');
    expect(stale.problems[0]).toMatch(/disparador/);
  });

  it('tareas: un fallo avisa, tres seguidos fallan', () => {
    expect(assessSubscription({ ...base, crons: [{ job: 'reconcile-payments', consecutiveFailures: 1, lastError: 'HTTP 503' }] }, NOW).level).toBe('warn');
    const bad = assessSubscription({ ...base, crons: [{ job: 'reconcile-payments', consecutiveFailures: 3, lastError: 'HTTP 503' }] }, NOW);
    expect(bad.level).toBe('bad');
    expect(bad.problems[0]).toMatch(/desde hace 3/);
  });

  it('una migración fallida y un registro sin republicar se señalan', () => {
    expect(assessSubscription({ ...base, lastMigration: { status: 'FAILED', error: 'P3018\nmás' } }, NOW)).toMatchObject({ level: 'bad' });
    const old = assessSubscription({ ...base, publishedAt: new Date(NOW - PUBLISH_STALE_MS - 1) }, NOW);
    expect(old.level).toBe('warn');
    expect(old.problems[0]).toMatch(/36 h/);
  });
});

describe('probeTenantHealth', () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    status: 'ok', version: 'dev', platform: true, tenantId: 'x', db: { ok: true, latencyMs: 3 },
    schema: { applied: '20261009090000_reconcile_queue', expected: '20261009090000_reconcile_queue', minRequired: '20261009090000_reconcile_queue', upToDate: true },
    onboarding: { complete: true, missing: [] }, ...over,
  });
  const fetchOf = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  const target = { tenantId: '01JAAAAAAAAAAAAAAAAAAAAAAA', host: 'a.test', declaredSchema: '20261009090000_reconcile_queue' };

  it('sin problemas', async () => {
    const r = await probeTenantHealth(target, { fetchImpl: fetchOf(200, detail()) });
    expect(r).toMatchObject({ reachable: true, problems: [] });
  });

  it('detecta deriva entre lo declarado en el registro y lo que hay en la BD', async () => {
    const r = await probeTenantHealth({ ...target, declaredSchema: '20261008213000_contact_inbox' }, { fetchImpl: fetchOf(200, detail()) });
    expect(r.problems.join()).toMatch(/Deriva/);
  });

  it('un 401 explica que el front no acepta el secreto; HTML o texto → no válido', async () => {
    const r = await probeTenantHealth(target, { fetchImpl: fetchOf(401, { error: 'No autorizado' }) });
    expect(r).toMatchObject({ reachable: false });
    expect(r.problems[0]).toMatch(/rechazó el secreto/);
    const html = await probeTenantHealth(target, { fetchImpl: async () => new Response('<html>', { status: 200 }) });
    expect(html.reachable).toBe(false);
  });

  it('la salud pública mínima ({status:ok}) NO basta: se necesita el detalle', async () => {
    expect((await probeTenantHealth(target, { fetchImpl: fetchOf(200, { status: 'ok' }) })).reachable).toBe(false);
  });
});

describe('healthOverview', () => {
  beforeEach(resetControlDb);
  it('ordena primero lo que falla y no incluye clientes en borrado', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const store = freshStore();
    const mk = async () => {
      const t = await rootCreateTenant();
      await verifyDomainManually(t.domain.id, actor);
      await publishSubscription(t.subscription.id, actor, store);
      return t;
    };
    const ok = await mk();
    const bad = await mk();
    const gone = await mk();
    await prisma.tenant.update({ where: { id: gone.tenant.id }, data: { status: 'DELETED' } });
    await prisma.tenantHealth.create({ data: { subscriptionId: ok.subscription.id, checkedAt: new Date(), ok: true, status: 'ok' } });
    await prisma.tenantHealth.create({ data: { subscriptionId: bad.subscription.id, checkedAt: new Date(), ok: false, status: 'unreachable', error: 'timeout' } });
    const rows = await healthOverview();
    expect(rows.map((r) => [r.tenantId, r.level])).toEqual([[bad.tenant.id, 'bad'], [ok.tenant.id, 'ok']]);
  });
});
