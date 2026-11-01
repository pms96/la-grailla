import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey } from '@grailla/contracts';
import { GET } from '@/app/api/cron/dispatch/route';
import { dispatchHttpStatus, dispatchTenantJobs, effectiveCronBudgetMs, MIN_CRON_BUDGET_MS } from '@/lib/services/crons';
import { verifyDomainManually } from '@/lib/services/domains';
import { publishSubscription } from '@/lib/services/snapshot';
import { freshStore, makeOperator, resetControlDb, rootCreateTenant } from './helpers';

const SECRET = 'secreto-de-prueba-del-disparador-0123456789';
const VERCEL_SECRET = 'secreto-de-vercel-cron-de-prueba-0123456789';
const call = (qs: string, auth?: string) => GET(new Request(`http://panel.test/api/cron/dispatch${qs}`, { headers: auth ? { authorization: auth } : {} }));

async function publishedTenant() {
  const { actor } = await makeOperator('SUPERADMIN');
  const { subscription, domain } = await rootCreateTenant();
  await verifyDomainManually(domain.id, actor);
  await publishSubscription(subscription.id, actor, freshStore());
}

beforeEach(resetControlDb);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PANEL_CRON_SECRET;
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/dispatch', () => {
  it('sin secreto configurado responde igual que con uno equivocado (401): no revela la configuración', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('?job=tenants', `Bearer ${SECRET}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No autorizado' });
  });

  it('sin cabecera o con un secreto distinto: 401', async () => {
    process.env.PANEL_CRON_SECRET = SECRET;
    expect((await call('?job=tenants')).status).toBe(401);
    expect((await call('?job=tenants', 'Bearer otro-secreto-distinto-del-disparador-xx')).status).toBe(401);
    expect((await call('?job=tenants', SECRET)).status).toBe(401);
  });

  it('un secreto demasiado corto se rechaza aunque coincida', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.PANEL_CRON_SECRET = 'corto';
    expect((await call('?job=tenants', 'Bearer corto')).status).toBe(401);
    process.env.CRON_SECRET = 'corto';
    expect((await call('?job=tenants', 'Bearer corto')).status).toBe(401);
  });

  it('con el secreto correcto ejecuta; tarea desconocida o ausente: 400', async () => {
    process.env.PANEL_CRON_SECRET = SECRET;
    const ok = await call('?job=tenants', `Bearer ${SECRET}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ due: 0, ran: 0 });
    expect((await call('?job=tenants&only=nada', `Bearer ${SECRET}`)).status).toBe(400);
    expect((await call('', `Bearer ${SECRET}`)).status).toBe(400);
    expect((await call('?job=snapshots-refresh', `Bearer ${SECRET}`)).status).toBe(200);
  });

  it('acepta CRON_SECRET (el nombre con el que Vercel Cron envía la cabecera) y PANEL_CRON_SECRET, y nada más', async () => {
    process.env.CRON_SECRET = VERCEL_SECRET;
    process.env.PANEL_CRON_SECRET = SECRET;
    expect((await call('?job=tenants', `Bearer ${VERCEL_SECRET}`)).status).toBe(200);
    expect((await call('?job=tenants', `Bearer ${SECRET}`)).status).toBe(200);
    expect((await call('?job=tenants', 'Bearer ni-uno-ni-otro-secreto-de-prueba-0123456')).status).toBe(401);
  });
});

describe('el código HTTP refleja si las tareas funcionaron', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = VERCEL_SECRET;
    vi.stubEnv('PLATFORM_CRON_MASTER', generateMasterKey());
    vi.stubEnv('TENANT_URL_TEMPLATE', 'http://{host}:9999');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('todas las tareas bien: 200', async () => {
    await publishedTenant();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const res = await call('?job=tenants&only=reconcile-payments', `Bearer ${VERCEL_SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ran: 1, ok: 1, failed: 0 });
  });

  it('un cliente falla: 500 (Vercel marca la ejecución como fallida) y el cuerpo dice cuántos', async () => {
    await publishedTenant();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const res = await call('?job=tenants&only=reconcile-payments', `Bearer ${VERCEL_SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ran: 1, failed: 1 });
  });

  it('el log dice QUÉ cliente falla y con qué', async () => {
    await publishedTenant();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await call('?job=tenants&only=reconcile-payments', `Bearer ${VERCEL_SECRET}`);
    const lines = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('[cron-dispatch] reconcile-payments falló para el cliente') && l.includes('HTTP 503'))).toBe(true);
  });

  it('H-125: un CRON_BUDGET_MS por debajo del mínimo (60 s) NO deja sin ejecutar reconcile-payments: se sube al mínimo y se avisa en el log', async () => {
    await publishedTenant();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('CRON_BUDGET_MS', '8000'); // el valor que recomendaba la documentación para Hobby: con él, reconcile-payments (55 s) no se lanzaba NUNCA
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await call('?job=tenants&only=reconcile-payments', `Bearer ${VERCEL_SECRET}`);
    expect(await res.json()).toMatchObject({ due: 1, ran: 1, deferred: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/CRON_BUDGET_MS=8000 es menor/);
  });

  it('había tareas vencidas y el presupuesto no dejó lanzar ninguna: 500, no un 200 que parezca bueno (la función del disparador, sin el mínimo de la ruta)', async () => {
    await publishedTenant();
    const out = await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: async () => new Response('{}', { status: 200 }), budgetMs: 8_000 });
    expect(out).toMatchObject({ due: 1, ran: 0, deferred: 1 });
    expect(dispatchHttpStatus(out)).toBe(500);
  });

  it('effectiveCronBudgetMs: sube a 60 s lo que esté por debajo, respeta lo de arriba y un valor ilegible usa el de por defecto', () => {
    expect([effectiveCronBudgetMs(8_000), effectiveCronBudgetMs(59_999), effectiveCronBudgetMs(60_000), effectiveCronBudgetMs(100_000)]).toEqual([MIN_CRON_BUDGET_MS, MIN_CRON_BUDGET_MS, 60_000, 100_000]);
    expect([effectiveCronBudgetMs(NaN), effectiveCronBudgetMs(0), effectiveCronBudgetMs(-5)]).toEqual([90_000, 90_000, 90_000]);
  });
});

describe('H-123: el refresco diario de registros también late', () => {
  it('job=snapshots-refresh hace GET a HEARTBEAT_SNAPSHOTS_URL (y no a la de tenants)', async () => {
    vi.stubEnv('HEARTBEAT_SNAPSHOTS_URL', 'https://hc-ping.com/snapshots-uuid');
    vi.stubEnv('HEARTBEAT_URL', 'https://hc-ping.com/tenants-uuid');
    process.env.CRON_SECRET = VERCEL_SECRET;
    const fetchSpy = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await call('?job=snapshots-refresh', `Bearer ${VERCEL_SECRET}`);
    expect(res.status).toBe(200);
    const urls = fetchSpy.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls).toContain('https://hc-ping.com/snapshots-uuid');
    expect(urls).not.toContain('https://hc-ping.com/tenants-uuid');
  });
});

