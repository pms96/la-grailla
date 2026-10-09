import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey } from '@grailla/contracts';
import { GET } from '@/app/api/cron/dispatch/route';
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

  it('había tareas vencidas y el presupuesto no dejó lanzar ninguna: 500, no un 200 que parezca bueno', async () => {
    await publishedTenant();
    vi.stubEnv('CRON_BUDGET_MS', '8000'); // menos que el tiempo máximo de una llamada (20 s): el valor que recomendaba la documentación para Hobby
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await call('?job=tenants&only=reconcile-payments', `Bearer ${VERCEL_SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ due: 1, ran: 0, deferred: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
