import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/cron/dispatch/route';
import { resetControlDb } from './helpers';

const SECRET = 'secreto-de-prueba-del-disparador-0123456789';
const call = (qs: string, auth?: string) => GET(new Request(`http://panel.test/api/cron/dispatch${qs}`, { headers: auth ? { authorization: auth } : {} }));

beforeEach(resetControlDb);
afterEach(() => {
  delete process.env.PANEL_CRON_SECRET;
});

describe('GET /api/cron/dispatch', () => {
  it('sin PANEL_CRON_SECRET configurado responde 500 y no hace nada', async () => {
    expect((await call('?job=tenants', `Bearer ${SECRET}`)).status).toBe(500);
  });

  it('sin cabecera o con un secreto distinto: 401', async () => {
    process.env.PANEL_CRON_SECRET = SECRET;
    expect((await call('?job=tenants')).status).toBe(401);
    expect((await call('?job=tenants', 'Bearer otro-secreto-distinto-del-disparador-xx')).status).toBe(401);
    expect((await call('?job=tenants', SECRET)).status).toBe(401);
  });

  it('un secreto demasiado corto se rechaza aunque coincida', async () => {
    process.env.PANEL_CRON_SECRET = 'corto';
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
});
