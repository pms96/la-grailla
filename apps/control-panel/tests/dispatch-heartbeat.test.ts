import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/cron/dispatch/route';

/* H-198: `sendHeartbeat(true)` salía siempre tras la pasada del disparador, incluso con tareas vencidas y NINGUNA ejecutada (todo diferido por presupuesto): el monitor externo veía
 * «vivo» mientras no se ejecutaba nada. La ruta ya contestaba 500 en ese caso; el latido debe decir lo mismo. Con clientes fallando, en cambio, el disparador sigue vivo (de eso
 * avisan las alertas), y con nada vencido tampoco hay problema. */
const summary = vi.hoisted(() => ({ value: { due: 0, ran: 0, ok: 0, failed: 0, deferred: 0, results: [] as unknown[] } }));
vi.mock('@/lib/services/crons', async (orig) => ({ ...(await orig<typeof import('@/lib/services/crons')>()), dispatchTenantJobs: async () => summary.value }));

const VERCEL_SECRET = 'secreto-de-vercel-cron-de-prueba-0123456789';
let fetchSpy: ReturnType<typeof vi.fn>;
const pings = () => fetchSpy.mock.calls.map((c) => String((c as unknown[])[0]));
const run = () => GET(new Request('http://panel.test/api/cron/dispatch?job=tenants', { headers: { authorization: `Bearer ${VERCEL_SECRET}` } }));

beforeEach(() => {
  process.env.CRON_SECRET = VERCEL_SECRET;
  vi.stubEnv('HEARTBEAT_URL', 'https://hc-ping.com/tenants-uuid');
  fetchSpy = vi.fn(async () => new Response('OK', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
});

describe('H-198: el latido del disparador dice la verdad', () => {
  it('con tareas vencidas y ninguna ejecutada (todo diferido) manda el latido de FALLO y la ruta responde 500', async () => {
    summary.value = { due: 3, ran: 0, ok: 0, failed: 0, deferred: 3, results: [] };
    const res = await run();
    expect(res.status).toBe(500);
    expect(pings()).toEqual(['https://hc-ping.com/tenants-uuid/fail']);
  });

  it('con tareas ejecutadas manda el latido normal (aunque algún cliente falle: de eso avisan las alertas)', async () => {
    summary.value = { due: 3, ran: 3, ok: 2, failed: 1, deferred: 0, results: [] };
    await run();
    expect(pings()).toEqual(['https://hc-ping.com/tenants-uuid']);
  });

  it('sin nada vencido manda el latido normal', async () => {
    summary.value = { due: 0, ran: 0, ok: 0, failed: 0, deferred: 0, results: [] };
    const res = await run();
    expect(res.status).toBe(200);
    expect(pings()).toEqual(['https://hc-ping.com/tenants-uuid']);
  });
});
