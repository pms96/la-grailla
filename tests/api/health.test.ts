import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/health/route';
import { FRONT_MIN_SCHEMA } from '@/lib/platform/min-schema';
import { latestMigrationOnDisk } from '../helpers/migrations';

/* M7: /api/health en modo normal (instalación única de La Grailla), contra la BD de desarrollo. */

const call = (secret: string | null) => new Request('http://localhost/api/health', { headers: secret === null ? {} : { Authorization: `Bearer ${secret}` } });

describe('GET /api/health (modo normal)', () => {
  it('público: 200 {status:"ok"} sin más datos', async () => {
    const res = await GET(call(null));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('con el CRON_SECRET: detalle, platform=false y sin tenantId; el esquema de dev está al día', async () => {
    const res = await GET(call(process.env.CRON_SECRET!));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.platform).toBe(false);
    expect(body.tenantId).toBeNull();
    expect(body.db.ok).toBe(true);
    expect(body.schema.applied).toBe(latestMigrationOnDisk());
    expect(body.schema.minRequired).toBe(FRONT_MIN_SCHEMA);
    expect(body.schema.upToDate).toBe(true);
    // La Grailla no se degrada por el onboarding: a la instalación única no se le exige.
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
  });

  it('con un secreto incorrecto solo ve la respuesta pública', async () => {
    expect(await (await GET(call('incorrecto'))).json()).toEqual({ status: 'ok' });
  });
});
