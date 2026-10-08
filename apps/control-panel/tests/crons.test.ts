import { beforeEach, describe, expect, it } from 'vitest';
import { deriveCronSecret, generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import { DUE_GRACE_MS, MAX_BACKOFF_MS, TENANT_JOBS, dispatchTenantJobs, nextRunDelay } from '@/lib/services/crons';
import { verifyDomainManually } from '@/lib/services/domains';
import { publishSubscription } from '@/lib/services/snapshot';
import { freshStore, makeOperator, resetControlDb, rootCreateTenant } from './helpers';

const MASTER = generateMasterKey();
process.env.PLATFORM_CRON_MASTER = MASTER;
process.env.TENANT_URL_TEMPLATE = 'http://{host}:9999';

type Call = { url: string; auth: string };
function fakeFetch(handler: (host: string, path: string) => { status: number; body?: unknown } | Error, calls: Call[] = []) {
  return async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    calls.push({ url: input, auth: String((init?.headers as Record<string, string>).Authorization) });
    expect(init?.redirect).toBe('manual');
    const r = handler(u.hostname, u.pathname);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  };
}

async function publishedTenant() {
  const { actor } = await makeOperator('SUPERADMIN');
  const { subscription, tenant, domain } = await rootCreateTenant();
  await verifyDomainManually(domain.id, actor);
  await publishSubscription(subscription.id, actor, freshStore());
  return { subscription, tenant, host: domain.host };
}

beforeEach(async () => {
  await resetControlDb();
});

describe('nextRunDelay', () => {
  const job = TENANT_JOBS['reconcile-payments'];
  it('éxito: intervalo menos el margen', () => expect(nextRunDelay(job, 0)).toBe(job.intervalMs - DUE_GRACE_MS));
  it('fallos: backoff exponencial con tope', () => {
    expect(nextRunDelay(job, 1)).toBe(job.intervalMs);
    expect(nextRunDelay(job, 3)).toBe(job.intervalMs * 4);
    expect(nextRunDelay(job, 30)).toBe(MAX_BACKOFF_MS);
  });
  it('la salud no se espacia aunque falle', () => expect(nextRunDelay(TENANT_JOBS.health, 7)).toBe(TENANT_JOBS.health.intervalMs - DUE_GRACE_MS));
});

describe('dispatchTenantJobs', () => {
  it('llama a cada cliente publicado con SU secreto derivado y no sigue redirecciones', async () => {
    const a = await publishedTenant();
    const b = await publishedTenant();
    const calls: Call[] = [];
    const out = await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: fakeFetch(() => ({ status: 200 }), calls) });
    expect(out).toMatchObject({ due: 2, ran: 2, ok: 2, failed: 0, deferred: 0 });
    const secretA = await deriveCronSecret(parseMasterKey(MASTER), a.tenant.id);
    const secretB = await deriveCronSecret(parseMasterKey(MASTER), b.tenant.id);
    expect(calls.find((c) => c.url.includes(a.host))!.auth).toBe(`Bearer ${secretA}`);
    expect(calls.find((c) => c.url.includes(b.host))!.auth).toBe(`Bearer ${secretB}`);
    expect(secretA).not.toBe(secretB);
    expect(calls[0].url).toMatch(/^http:\/\/.+:9999\/api\/cron\/reconcile-payments$/);
  });

  it('no repite lo que aún no toca, y lo vuelve a lanzar cuando vence', async () => {
    const t = await publishedTenant();
    let clock = Date.now();
    const opts = { jobs: ['reconcile-payments'], now: () => clock, fetchImpl: fakeFetch(() => ({ status: 200 })) };
    expect((await dispatchTenantJobs(opts)).ran).toBe(1);
    expect((await dispatchTenantJobs(opts)).due).toBe(0);
    clock += TENANT_JOBS['reconcile-payments'].intervalMs;
    expect((await dispatchTenantJobs(opts)).ran).toBe(1);
    const state = await prisma.cronState.findUniqueOrThrow({ where: { subscriptionId_job: { subscriptionId: t.subscription.id, job: 'reconcile-payments' } } });
    expect(state).toMatchObject({ lastStatus: 'ok', lastHttp: 200, consecutiveFailures: 0 });
  });

  it('un cliente que falla se espacia solo y NO frena a los demás', async () => {
    const bad = await publishedTenant();
    const good = await publishedTenant();
    let clock = Date.now();
    const handler = (host: string) => (host === bad.host ? { status: 503 } : { status: 200 });
    const run = () => dispatchTenantJobs({ jobs: ['reconcile-payments'], now: () => clock, fetchImpl: fakeFetch(handler) });

    expect(await run()).toMatchObject({ ran: 2, ok: 1, failed: 1 });
    const state = (id: string) => prisma.cronState.findUniqueOrThrow({ where: { subscriptionId_job: { subscriptionId: id, job: 'reconcile-payments' } } });
    expect(await state(bad.subscription.id)).toMatchObject({ consecutiveFailures: 1, lastStatus: 'error', lastHttp: 503 });

    // 5 min después: el sano vuelve a correr; el que falló espera el doble (backoff) en el 2.º fallo.
    clock += 5 * 60_000;
    expect(await run()).toMatchObject({ ran: 2, failed: 1 });
    expect((await state(bad.subscription.id)).consecutiveFailures).toBe(2);
    clock += 5 * 60_000; // el sano toca; el malo (10 min de espera) todavía no
    const third = await run();
    expect(third).toMatchObject({ ran: 1, ok: 1 });
    expect((await state(good.subscription.id)).consecutiveFailures).toBe(0);
  });

  it('un error de red o un 401 quedan anotados sin lanzar excepción', async () => {
    const a = await publishedTenant();
    const out = await dispatchTenantJobs({ jobs: ['cleanup-waiting-room'], fetchImpl: fakeFetch(() => new Error('connect ECONNREFUSED')) });
    expect(out.failed).toBe(1);
    const s = await prisma.cronState.findFirstOrThrow({ where: { subscriptionId: a.subscription.id } });
    expect(s.lastError).toMatch(/ECONNREFUSED/);
    const unauthorized = await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: fakeFetch(() => ({ status: 401 })) });
    expect(unauthorized.failed).toBe(1);
    const u = await prisma.cronState.findFirstOrThrow({ where: { subscriptionId: a.subscription.id, job: 'reconcile-payments' } });
    expect(u.lastError).toMatch(/rechazó el secreto/);
  });

  it('respeta el presupuesto de tiempo: lo que no cabe queda diferido y se atiende primero en la siguiente', async () => {
    const tenants = [await publishedTenant(), await publishedTenant(), await publishedTenant()];
    let clock = Date.now();
    const fetchImpl = async () => {
      clock += 10_000; // cada llamada «tarda» 10 s
      return new Response('{}', { status: 200 });
    };
    const first = await dispatchTenantJobs({ jobs: ['reconcile-payments'], now: () => clock, budgetMs: 15_000, concurrency: 1, fetchImpl });
    expect(first).toMatchObject({ due: 3, ran: 2, deferred: 1 });
    // La siguiente invocación atiende al que no llegó a correr (lastRunAt nulo va primero), no repite a los otros.
    const second = await dispatchTenantJobs({ jobs: ['reconcile-payments'], now: () => clock, budgetMs: 60_000, concurrency: 1, fetchImpl });
    expect(second.ran).toBe(1);
    const never = await prisma.cronState.count({ where: { job: 'reconcile-payments', lastRunAt: null } });
    expect(never).toBe(0);
    expect(tenants).toHaveLength(3);
  });

  it('no llama a clientes sin publicar ni en borrado, pero sí a uno suspendido (sus cobros en vuelo)', async () => {
    const live = await publishedTenant();
    await rootCreateTenant(); // sin dominio verificado ni publicar
    const susp = await publishedTenant();
    const gone = await publishedTenant();
    await prisma.tenant.update({ where: { id: susp.tenant.id }, data: { status: 'SUSPENDED' } });
    await prisma.tenant.update({ where: { id: gone.tenant.id }, data: { status: 'PENDING_DELETION' } });
    const calls: Call[] = [];
    await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: fakeFetch(() => ({ status: 200 }), calls) });
    expect(calls.map((c) => new URL(c.url).hostname).sort()).toEqual([live.host, susp.host].sort());
  });

  it('la tarea de salud guarda el estado del cliente y detecta deriva de esquema', async () => {
    const t = await publishedTenant();
    await prisma.subscription.update({ where: { id: t.subscription.id }, data: { schemaVersion: '20261008213000_contact_inbox' } });
    const detail = {
      status: 'ok', version: 'abc1234', platform: true, tenantId: t.tenant.id,
      db: { ok: true, latencyMs: 4 },
      schema: { applied: '20261009090000_reconcile_queue', expected: '20261009090000_reconcile_queue', minRequired: '20261009090000_reconcile_queue', upToDate: true },
      onboarding: { complete: false, missing: ['privacy_policy'] },
    };
    await dispatchTenantJobs({ jobs: ['health'], fetchImpl: fakeFetch(() => ({ status: 200, body: detail })) });
    const h = await prisma.tenantHealth.findUniqueOrThrow({ where: { subscriptionId: t.subscription.id } });
    expect(h).toMatchObject({ ok: false, status: 'degraded', dbOk: true, schemaUpToDate: true, onboardingComplete: false, onboardingMissing: ['privacy_policy'], version: 'abc1234' });
    expect(h.error).toMatch(/Deriva/);
    expect(h.error).toMatch(/privacy_policy/);

    await dispatchTenantJobs({ jobs: ['health'], now: () => Date.now() + 10 * 60_000, fetchImpl: fakeFetch(() => ({ status: 503, body: { status: 'error' } })) });
    expect((await prisma.tenantHealth.findUniqueOrThrow({ where: { subscriptionId: t.subscription.id } })).status).toBe('unreachable');
  });

  it('rechaza una tarea desconocida', async () => {
    await expect(dispatchTenantJobs({ jobs: ['borrar-todo'] })).rejects.toThrow(/desconocida/);
  });
});
