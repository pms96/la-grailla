import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { deriveInstallationSecret, generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { getAuthOptions } from '@/lib/auth';
import { platformMiddleware } from '@/lib/tenant/middleware';
import { resetResolverStateForTests, setRegistryReaderForTests } from '@/lib/tenant/resolve';
import { SESSION_COOKIE_DEFAULT, SESSION_COOKIE_HOST, SESSION_COOKIE_SECURE, sessionCookieName } from '@/lib/tenant/session-cookie';
import { enablePlatformEnv } from '../helpers/platform';
import { FakeRegistry, makeSigner, publishTenant } from '../helpers/registry';
import { testTenantContext, withTenantForTest } from '../helpers/tenant-dbs';

const A = '01HF7YAT00AAAAAAAAAAAAAAAA';
const master = parseMasterKey(generateMasterKey());
let env: ReturnType<typeof enablePlatformEnv>;

beforeEach(() => {
  env = enablePlatformEnv();
});
afterEach(() => {
  env.restore();
  setRegistryReaderForTests(null);
  resetResolverStateForTests();
});

describe('nombre de la cookie de sesión por cliente', () => {
  it('cliente nuevo en dominio real: __Host- (sin Domain, Secure, Path=/)', () => {
    expect(sessionCookieName({ tenantId: A, host: 'a.cliente.es' })).toBe(SESSION_COOKIE_HOST);
    const cookies = withTenantForTest('a', () => getAuthOptions().cookies, { host: 'a.cliente.es' });
    expect(cookies?.sessionToken).toMatchObject({ name: SESSION_COOKIE_HOST, options: { httpOnly: true, secure: true, path: '/', sameSite: 'lax' } });
    expect(cookies?.sessionToken?.options).not.toHaveProperty('domain');
  });

  it('el cliente legacy conserva __Secure- (cambiarlo cerraría las sesiones abiertas en el corte)', () => {
    expect(sessionCookieName({ tenantId: env.LEGACY_TENANT_ID, host: 'www.lagrailla.es' })).toBe(SESSION_COOKIE_SECURE);
    expect(withTenantForTest('a', () => getAuthOptions().cookies, { tenantId: env.LEGACY_TENANT_ID, host: 'www.lagrailla.es' })).toBeUndefined();
  });

  it('en *.localhost no hay HTTPS: nombre por defecto', () => {
    expect(sessionCookieName({ tenantId: A, host: 'a.localhost:3000' })).toBe(SESSION_COOKIE_DEFAULT);
    expect(testTenantContext('a').host).toBeTruthy();
  });

  it('el middleware lee la cookie con ese nombre y no otra: una cookie plantada con otro nombre no vale', async () => {
    const signer = await makeSigner();
    process.env.SNAPSHOT_PUBKEYS = JSON.stringify({ [signer.kid]: signer.publicKey });
    const reg = new FakeRegistry();
    setRegistryReaderForTests(reg);
    resetResolverStateForTests();
    await publishTenant(reg, signer, { tenantId: A, hosts: ['a.cliente.es'], master });
    const secret = await deriveInstallationSecret(parseMasterKey(env.PLATFORM_SESSION_MASTER), A, 0, 'session');
    const jwt = await encode({ token: { id: 'u1', role: 'ADMIN', tid: A }, secret });
    const req = (cookieName: string) =>
      new NextRequest('https://a.cliente.es/admin', { headers: { host: 'a.cliente.es', cookie: `${cookieName}=${jwt}` } });

    expect((await platformMiddleware(req(SESSION_COOKIE_HOST))).headers.get('x-middleware-next')).toBe('1');
    // Con el nombre antiguo (__Secure-) o sin prefijo, un cliente nuevo no tiene sesión: redirige al login.
    expect((await platformMiddleware(req(SESSION_COOKIE_SECURE))).status).toBe(307);
    expect((await platformMiddleware(req(SESSION_COOKIE_DEFAULT))).status).toBe(307);
    delete process.env.SNAPSHOT_PUBKEYS;
  });
});
