import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveCronSecret, generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { FRONT_MIN_SCHEMA } from '@/lib/platform/min-schema';
import { enablePlatformEnv } from '../helpers/platform';
import { latestMigrationOnDisk } from '../helpers/migrations';
import { TEST_TENANT_IDS, disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* M7: /api/health. Público y sin datos; con el secreto de cron del cliente, el detalle exacto. */

// Mínimo de esquema ajustable por test (por defecto, el real del build).
const min = vi.hoisted(() => ({ value: '', real: '' }));
vi.mock('@/lib/platform/min-schema', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/platform/min-schema')>();
  min.real = real.FRONT_MIN_SCHEMA;
  min.value = min.real;
  return {
    get FRONT_MIN_SCHEMA() {
      return min.value;
    },
  };
});

let env: ReturnType<typeof enablePlatformEnv>;
let cronMaster: string;
let route: typeof import('@/app/api/health/route');

const call = (secret: string | null) => new Request('http://localhost/api/health', { headers: secret === null ? {} : { Authorization: `Bearer ${secret}` } });
const secretFor = (tenantId: string) => deriveCronSecret(parseMasterKey(cronMaster), tenantId);
const detailOf = async (slot: 'a' | 'b', over = {}) => {
  const secret = await secretFor(over && 'tenantId' in over ? String((over as { tenantId: string }).tenantId) : TEST_TENANT_IDS[slot]);
  return withTenantForTest(slot, () => route.GET(call(secret)), over);
};
async function fill(slot: 'a' | 'b') {
  for (const [key, value] of [['admin_email', 'duena@cliente.es'], ['legal_notice', 'a'], ['privacy_policy', 'b'], ['cookies_policy', 'c']]) {
    await tenantClient(slot).appConfig.create({ data: { key, value } });
  }
}

beforeAll(async () => {
  await ensureTenantDatabases();
  route = await import('@/app/api/health/route');
}, 180_000);
beforeEach(async () => {
  cronMaster = generateMasterKey();
  env = enablePlatformEnv({ PLATFORM_CRON_MASTER: cronMaster, CRON_SECRET: 'global-de-tests', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890' });
  vi.stubEnv('FRONT_SCHEMA_EXPECTED', latestMigrationOnDisk());
  min.value = min.real;
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
});
afterEach(() => env.restore());
afterAll(async () => {
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('marca de la BD (platform_tenant_id)', () => {
  const putMarker = (slot: 'a' | 'b', value: string) => tenantClient(slot).appConfig.create({ data: { key: 'platform_tenant_id', value, group: 'platform' } });

  it('sin marca (BD anterior a la plataforma): tenantMarker null y nada cambia', async () => {
    await fill('a');
    const res = await detailOf('a');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', tenantId: TEST_TENANT_IDS.a, tenantMarker: null });
  });

  it('con la marca de ESTE cliente: se devuelve y todo sigue bien', async () => {
    await fill('a');
    await putMarker('a', TEST_TENANT_IDS.a);
    const res = await detailOf('a');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', tenantMarker: TEST_TENANT_IDS.a });
  });

  it('con la marca de OTRO cliente (URLs apuntando a la BD de otro): error, 503 y la marca a la vista del panel', async () => {
    await fill('a');
    await putMarker('a', TEST_TENANT_IDS.b);
    const res = await detailOf('a');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'error', tenantId: TEST_TENANT_IDS.a, tenantMarker: TEST_TENANT_IDS.b });
  });

  it('también lo ve un monitor externo en la respuesta pública, sin decir por qué', async () => {
    await putMarker('a', TEST_TENANT_IDS.b);
    const res = await withTenantForTest('a', () => route.GET(call(null)));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error' });
  });
});

describe('respuesta pública (sin secreto)', () => {
  it('200 {status:"ok"} y NADA más si la BD responde', async () => {
    const res = await withTenantForTest('a', () => route.GET(call(null)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('un secreto incorrecto, o el de OTRO cliente, solo ve la respuesta pública', async () => {
    const other = await secretFor(TEST_TENANT_IDS.a);
    expect(await (await withTenantForTest('b', () => route.GET(call(other)))).json()).toEqual({ status: 'ok' });
    expect(await (await withTenantForTest('a', () => route.GET(call('lo-que-sea')))).json()).toEqual({ status: 'ok' });
    // el CRON_SECRET global tampoco abre el detalle de un cliente que no es el legacy
    expect(await (await withTenantForTest('a', () => route.GET(call('global-de-tests')))).json()).toEqual({ status: 'ok' });
  });

  it('BD caída: 503 {status:"error"} sin ningún dato (ni mensaje de error ni URL)', async () => {
    const down = { testDbUrl: 'postgresql://nadie:nada@127.0.0.1:1/lagrailla_test_caida?connect_timeout=1' };
    const res = await withTenantForTest('a', () => route.GET(call(null)), down);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sin contexto de cliente en modo plataforma: 503 público, sin lanzar', async () => {
    const res = await route.GET(call(null));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error' });
  });
});

describe('puerta de esquema', () => {
  it('con el esquema del REGISTRO atrasado el público ve 503 «maintenance» (no «ok») y el detalle dice serving:false', async () => {
    await fill('a');
    const stale = { schemaVersion: '20200101000000_antigua' };
    const pub = await withTenantForTest('a', () => route.GET(call(null)), stale);
    expect(pub.status).toBe(503);
    expect(await pub.json()).toEqual({ status: 'maintenance' });
    const detail = await (await detailOf('a', stale)).json();
    expect(detail).toMatchObject({ serving: false, status: 'degraded' });
  });
});

describe('detalle (con el secreto de cron del cliente)', () => {
  it('forma EXACTA: status, version, platform, tenantId, tenantMarker, db, schema y onboarding, más el bloque ADITIVO `ops`', async () => {
    await fill('a');
    const res = await detailOf('a');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['db', 'onboarding', 'ops', 'platform', 'schema', 'serving', 'status', 'tenantId', 'tenantMarker', 'version']);
    expect(body).toEqual({
      status: 'ok',
      version: 'abcdef1',
      platform: true,
      tenantId: TEST_TENANT_IDS.a,
      tenantMarker: null,
      serving: true,
      db: { ok: true, latencyMs: expect.any(Number) },
      schema: { applied: latestMigrationOnDisk(), expected: latestMigrationOnDisk(), minRequired: FRONT_MIN_SCHEMA, upToDate: true },
      onboarding: { complete: true, missing: [] },
      // `ops` (P0-07): aditivo; BD sin pedidos ni pasada del cron. Su forma y sus valores se prueban en ops-health.test.ts.
      ops: { generatedAt: expect.any(String), pendingOldestMinutes: null, pendingOver20min: 0, emailsUnsent: 0, emailsFailed: 0, reconcile: null, gateway: null, sales: { orders15min: 0, waitingRoom: 0 }, obligations: { ticketOrdersPending: 0, futureEventsWithTickets: 0, shopOrdersPending: 0, shopOrdersToShip: 0 } },
    });
    expect(Object.keys(body.db).sort()).toEqual(['latencyMs', 'ok']);
    expect(Object.keys(body.schema).sort()).toEqual(['applied', 'expected', 'minRequired', 'upToDate']);
    expect(body.db.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('degraded (200) si el esquema aplicado está por detrás del mínimo del build', async () => {
    await fill('a');
    min.value = '29990101000000_futura';
    const res = await detailOf('a');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.schema).toMatchObject({ applied: latestMigrationOnDisk(), minRequired: '29990101000000_futura', upToDate: false });
    expect(body.db.ok).toBe(true);
  });

  it('degraded (200) para un cliente nuevo con el onboarding incompleto, y ok al completarlo', async () => {
    const before = await (await detailOf('a')).json();
    expect(before.status).toBe('degraded');
    expect(before.onboarding).toEqual({ complete: false, missing: ['admin_email', 'legal_notice', 'privacy_policy', 'cookies_policy'] });
    await fill('a');
    expect((await (await detailOf('a')).json()).status).toBe('ok');
  });

  it('el cliente legacy informa su onboarding pero no sale degradado por ello (ya está publicado)', async () => {
    const res = await detailOf('a', { tenantId: env.LEGACY_TENANT_ID });
    const body = await res.json();
    expect(body.tenantId).toBe(env.LEGACY_TENANT_ID);
    expect(body.onboarding.complete).toBe(false);
    expect(body.status).toBe('ok');
  });

  it('BD caída con secreto válido: 503 con status "error" y db.ok=false (sin URL ni mensaje)', async () => {
    const down = { testDbUrl: 'postgresql://nadie:nada@127.0.0.1:1/lagrailla_test_caida?connect_timeout=1' };
    const res = await detailOf('a', down);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'error', db: { ok: false }, schema: { applied: null, upToDate: false } });
    expect(JSON.stringify(body)).not.toMatch(/postgres|127\.0\.0\.1|nadie|nada@/);
  });

  it('versión «dev» sin VERCEL_GIT_COMMIT_SHA', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect((await (await detailOf('a')).json()).version).toBe('dev');
  });

  it('no filtra secretos ni URLs de BD', async () => {
    await fill('a');
    const text = JSON.stringify(await (await detailOf('a')).json());
    for (const forbidden of [cronMaster, env.PLATFORM_SESSION_MASTER, env.PLATFORM_CONTEXT_KEY, env.LEGACY_NEXTAUTH_SECRET, 'global-de-tests', 'postgres']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
