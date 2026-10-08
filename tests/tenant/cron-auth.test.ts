import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveCronSecret, generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { authorizeCron } from '@/lib/cron-auth';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { TEST_TENANT_IDS, disconnectTenantClients, ensureTenantDatabases, withTenantForTest } from '../helpers/tenant-dbs';

/* M7: cada cliente tiene su secreto de cron, derivado de PLATFORM_CRON_MASTER + tenantId. El de A no abre B. */

const GLOBAL = 'cron-secret-global-de-tests';
let env: ReturnType<typeof enablePlatformEnv>;
let cronMaster: string;
let cleanupRoute: typeof import('@/app/api/cron/cleanup-waiting-room/route');
let reconcileRoute: typeof import('@/app/api/cron/reconcile-payments/route');

const bearer = (secret: string | null) => new Request('http://localhost/api/cron/x', { headers: secret === null ? {} : { Authorization: `Bearer ${secret}` } });
const secretFor = (tenantId: string) => deriveCronSecret(parseMasterKey(cronMaster), tenantId);

beforeAll(async () => {
  await ensureTenantDatabases();
  cleanupRoute = await import('@/app/api/cron/cleanup-waiting-room/route');
  reconcileRoute = await import('@/app/api/cron/reconcile-payments/route');
}, 180_000);
beforeEach(() => {
  cronMaster = generateMasterKey();
  env = enablePlatformEnv({ PLATFORM_CRON_MASTER: cronMaster, CRON_SECRET: GLOBAL });
});
afterEach(() => env.restore());
afterAll(async () => {
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('authorizeCron en modo plataforma', () => {
  it('el secreto derivado de A abre A y se RECHAZA en B', async () => {
    const a = await secretFor(TEST_TENANT_IDS.a);
    expect(await withTenantForTest('a', () => authorizeCron(bearer(a)))).toBe('ok');
    expect(await withTenantForTest('b', () => authorizeCron(bearer(a)))).toBe('unauthorized');
    const b = await secretFor(TEST_TENANT_IDS.b);
    expect(await withTenantForTest('b', () => authorizeCron(bearer(b)))).toBe('ok');
    expect(await withTenantForTest('a', () => authorizeCron(bearer(b)))).toBe('unauthorized');
  });

  it('sin cabecera, con otro esquema o con un secreto cualquiera: unauthorized', async () => {
    const a = await secretFor(TEST_TENANT_IDS.a);
    expect(await withTenantForTest('a', () => authorizeCron(bearer(null)))).toBe('unauthorized');
    expect(await withTenantForTest('a', () => authorizeCron(bearer('otro')))).toBe('unauthorized');
    expect(await withTenantForTest('a', () => authorizeCron(new Request('http://x', { headers: { Authorization: a } })))).toBe('unauthorized');
    expect(await withTenantForTest('a', () => authorizeCron(new Request('http://x', { headers: { Authorization: `Basic ${a}` } })))).toBe('unauthorized');
  });

  it('el CRON_SECRET global NO abre a un cliente que no es el legacy', async () => {
    expect(await withTenantForTest('a', () => authorizeCron(bearer(GLOBAL)))).toBe('unauthorized');
  });

  it('el cliente legacy acepta su derivado Y el CRON_SECRET global (los workflows de GitHub siguen valiendo)', async () => {
    const legacy = env.LEGACY_TENANT_ID;
    const over = { tenantId: legacy };
    expect(await withTenantForTest('a', () => authorizeCron(bearer(GLOBAL)), over)).toBe('ok');
    expect(await withTenantForTest('a', async () => authorizeCron(bearer(await secretFor(legacy))), over)).toBe('ok');
    expect(await withTenantForTest('a', () => authorizeCron(bearer('otro')), over)).toBe('unauthorized');
    // y el secreto del legacy no abre a un cliente nuevo
    expect(await withTenantForTest('a', async () => authorizeCron(bearer(await secretFor(legacy))))).toBe('unauthorized');
  });

  it('sin PLATFORM_CRON_MASTER: not_configured para un cliente nuevo, aunque exista CRON_SECRET; el legacy sigue con el global', async () => {
    vi.stubEnv('PLATFORM_CRON_MASTER', '');
    expect(await withTenantForTest('a', () => authorizeCron(bearer(GLOBAL)))).toBe('not_configured');
    expect(await withTenantForTest('a', () => authorizeCron(bearer(GLOBAL)), { tenantId: env.LEGACY_TENANT_ID })).toBe('ok');
  });

  it('legacy sin maestro y sin CRON_SECRET: not_configured', async () => {
    vi.stubEnv('PLATFORM_CRON_MASTER', '');
    vi.stubEnv('CRON_SECRET', '');
    expect(await withTenantForTest('a', () => authorizeCron(bearer('x')), { tenantId: env.LEGACY_TENANT_ID })).toBe('not_configured');
  });

  it('un maestro ilegible equivale a no tenerlo (y no imprime su valor)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('PLATFORM_CRON_MASTER', 'esto-no-es-una-clave-valida');
    expect(await withTenantForTest('a', () => authorizeCron(bearer('x')))).toBe('not_configured');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('esto-no-es-una-clave-valida');
    spy.mockRestore();
  });

  it('sin contexto de cliente falla cerrado (lanza, no cae a un secreto global)', async () => {
    await expect(authorizeCron(bearer(GLOBAL))).rejects.toThrow();
  });
});

describe('rutas de cron en modo plataforma', () => {
  it('cleanup-waiting-room: el secreto de A entra en A (200) y en B da 401; sin cabecera 401', async () => {
    const a = await secretFor(TEST_TENANT_IDS.a);
    const ok = await withTenantForTest('a', () => cleanupRoute.GET(bearer(a)));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: expect.any(Number) });
    const wrong = await withTenantForTest('b', () => cleanupRoute.GET(bearer(a)));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'No autorizado' });
    expect((await withTenantForTest('a', () => cleanupRoute.GET(bearer(null)))).status).toBe(401);
  });

  it('reconcile-payments: el secreto de A se rechaza en B (401) y sin cabecera también; sin maestro, 500 «Cron no configurado»', async () => {
    const a = await secretFor(TEST_TENANT_IDS.a);
    expect((await withTenantForTest('b', () => reconcileRoute.GET(bearer(a)))).status).toBe(401);
    expect((await withTenantForTest('a', () => reconcileRoute.GET(bearer(null)))).status).toBe(401);
    const ok = await withTenantForTest('a', () => reconcileRoute.GET(bearer(a)));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ checked: expect.any(Number), errors: 0 });

    vi.stubEnv('PLATFORM_CRON_MASTER', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const nc = await withTenantForTest('a', () => reconcileRoute.GET(bearer(a)));
    expect(nc.status).toBe(500);
    expect(await nc.json()).toEqual({ error: 'Cron no configurado' });
    vi.restoreAllMocks();
  });
});

describe('authorizeCron en modo normal (intacto)', () => {
  const original = process.env.CRON_SECRET;
  beforeEach(() => {
    env.restore(); // vuelve a PLATFORM_MODE apagado
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('Bearer CRON_SECRET: ok / unauthorized / not_configured, sin contexto de cliente', async () => {
    process.env.CRON_SECRET = 'secreto-normal';
    expect(await authorizeCron(bearer('secreto-normal'))).toBe('ok');
    expect(await authorizeCron(bearer('otro'))).toBe('unauthorized');
    expect(await authorizeCron(bearer(null))).toBe('unauthorized');
    delete process.env.CRON_SECRET;
    expect(await authorizeCron(bearer('secreto-normal'))).toBe('not_configured');
  });

  it('ignora PLATFORM_CRON_MASTER: un derivado no abre nada en modo normal', async () => {
    process.env.CRON_SECRET = 'secreto-normal';
    vi.stubEnv('PLATFORM_CRON_MASTER', cronMaster);
    expect(await authorizeCron(bearer(await secretFor(TEST_TENANT_IDS.a)))).toBe('unauthorized');
    vi.unstubAllEnvs();
  });
});
