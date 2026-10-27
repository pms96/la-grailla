import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { deriveInstallationSecret, generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { platformMiddleware, isNeverBlockable } from '@/lib/tenant/middleware';
import { CONTEXT_HEADER } from '@/lib/tenant/context';
import { signContext } from '@/lib/tenant/context-sign';
import { verifyContext } from '@/lib/tenant/context-verify';
import { resetResolverStateForTests, setRegistryReaderForTests } from '@/lib/tenant/resolve';
import { enablePlatformEnv } from '../helpers/platform';
import { FakeRegistry, makeSigner, publishTenant } from '../helpers/registry';
import { testTenantContext } from '../helpers/tenant-dbs';

const A = '01HF7YAT00AAAAAAAAAAAAAAAA';
const B = '01HF7YAT00BBBBBBBBBBBBBBBB';
const C = '01HF7YAT00CCCCCCCCCCCCCCCC';
let env: ReturnType<typeof enablePlatformEnv>;
let reg: FakeRegistry;
const master = parseMasterKey(generateMasterKey());

beforeEach(async () => {
  const signer = await makeSigner();
  env = enablePlatformEnv({ SNAPSHOT_PUBKEYS: JSON.stringify({ [signer.kid]: signer.publicKey }) });
  reg = new FakeRegistry();
  resetResolverStateForTests();
  setRegistryReaderForTests(reg);
  await publishTenant(reg, signer, { tenantId: A, hosts: ['a.cliente.test'], master, modules: ['tienda', 'entradas'] });
  await publishTenant(reg, signer, { tenantId: B, hosts: ['b.cliente.test'], master, modules: ['tienda', 'entradas'] });
  await publishTenant(reg, signer, { tenantId: C, hosts: ['c.cliente.test'], master, status: 'SUSPENDED', modules: ['tienda', 'entradas'] });
  await publishTenant(reg, signer, { tenantId: env.LEGACY_TENANT_ID, hosts: ['legacy.cliente.test'], master, modules: ['tienda', 'entradas'] });
});
afterEach(() => {
  env.restore();
  setRegistryReaderForTests(null);
  resetResolverStateForTests();
});

const req = (host: string, path = '/', init: { method?: string; headers?: Record<string, string>; cookie?: string } = {}) =>
  new NextRequest(`http://${host}${path}`, { method: init.method ?? 'GET', headers: { host, ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers } });

/** Cookie de sesión de staff como la emitiría next-auth para ese cliente (host *.test → sin prefijo __Secure-). */
async function sessionCookie(tenantId: string, role: string, opts: { epoch?: number; tid?: string | null; legacy?: boolean } = {}) {
  const secret = opts.legacy ? env.LEGACY_NEXTAUTH_SECRET : await deriveInstallationSecret(parseMasterKey(env.PLATFORM_SESSION_MASTER), tenantId, opts.epoch ?? 0, 'session');
  const token: { id: string; role: string; tid?: string } = { id: 'u1', role };
  if (opts.tid !== null) token.tid = opts.tid ?? tenantId;
  return `next-auth.session-token=${await encode({ token, secret })}`;
}

const forwardedCtx = (res: Response) => {
  const raw = res.headers.get(`x-middleware-request-${CONTEXT_HEADER}`);
  return raw ? verifyContext(raw, parseMasterKey(env.PLATFORM_CONTEXT_KEY), Date.now()) : null;
};

describe('resolución del cliente', () => {
  it('un host que no está en el registro devuelve 404 y no pasa a ningún handler', async () => {
    const res = await platformMiddleware(req('nadie.cliente.test'));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-middleware-next')).toBeNull();
  });

  it('pasa el contexto del cliente a los handlers en una cabecera firmada', async () => {
    const res = await platformMiddleware(req('a.cliente.test', '/eventos'));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(forwardedCtx(res)).toMatchObject({ tenantId: A, product: 'grailla', host: 'a.cliente.test', primaryDomain: 'a.cliente.test', modules: ['tienda', 'entradas'] });
  });

  it('una cabecera de contexto que mande el cliente se descarta: manda el Host, no lo que diga la petición', async () => {
    const forged = await signContext(testTenantContext('b', { tenantId: B }), parseMasterKey(env.PLATFORM_CONTEXT_KEY));
    const res = await platformMiddleware(req('a.cliente.test', '/eventos', { headers: { [CONTEXT_HEADER]: forged, 'x-forwarded-host': 'b.cliente.test' } }));
    expect(forwardedCtx(res)?.tenantId).toBe(A);
  });

  it('el contexto no lleva URLs de BD en claro', async () => {
    const res = await platformMiddleware(req('a.cliente.test', '/'));
    const raw = res.headers.get(`x-middleware-request-${CONTEXT_HEADER}`)!;
    expect(Buffer.from(raw.split('.')[0], 'base64url').toString()).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('sin clave de contexto no se sirve nada (falla cerrado)', async () => {
    delete process.env.PLATFORM_CONTEXT_KEY;
    expect((await platformMiddleware(req('a.cliente.test'))).status).toBe(503);
  });

  it('registro caído y sin caché: 503 con Retry-After', async () => {
    reg.failWith = new Error('caído');
    const res = await platformMiddleware(req('a.cliente.test'));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });
});

describe('cliente suspendido', () => {
  it('no se sirve, salvo webhooks y crons (un pago o un cron que no llega es dinero perdido)', async () => {
    expect((await platformMiddleware(req('c.cliente.test', '/eventos'))).status).toBe(503);
    expect((await platformMiddleware(req('c.cliente.test', '/api/events'))).status).toBe(503);
    expect((await platformMiddleware(req('c.cliente.test', '/api/webhooks/stripe', { method: 'POST' }))).headers.get('x-middleware-next')).toBe('1');
    expect((await platformMiddleware(req('c.cliente.test', '/api/cron/reconcile-payments'))).headers.get('x-middleware-next')).toBe('1');
    expect(isNeverBlockable('/api/webhooks/x')).toBe(true);
    expect(isNeverBlockable('/api/orders')).toBe(false);
  });

  it('la revocación/suspensión corta TAMBIÉN la puerta del evento (escáner), con sesión de staff o sin ella', async () => {
    const cookie = await sessionCookie(C, 'TAQUILLA');
    for (const path of ['/acceso', '/api/access/events', '/api/access/capacity']) {
      expect((await platformMiddleware(req('c.cliente.test', path, { cookie }))).status, path).toBe(503);
      expect((await platformMiddleware(req('c.cliente.test', path))).status, path).toBe(503);
    }
    expect((await platformMiddleware(req('c.cliente.test', '/api/scan', { method: 'POST', cookie, headers: { origin: 'http://c.cliente.test' } }))).status).toBe(503);
    expect(isNeverBlockable('/acceso')).toBe(false);
    expect(isNeverBlockable('/api/scan')).toBe(false);
    expect(isNeverBlockable('/api/access/events')).toBe(false);
  });
});

describe('sesión de staff con el secreto de cada cliente', () => {
  it('sin cookie: /admin redirige al login, /acceso también y una API de staff da 401', async () => {
    expect((await platformMiddleware(req('a.cliente.test', '/admin'))).status).toBe(307);
    expect((await platformMiddleware(req('a.cliente.test', '/acceso'))).status).toBe(307);
    const api = await platformMiddleware(req('a.cliente.test', '/api/admin/orders'));
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'No autorizado' });
  });

  it('el ADMIN de A entra en A', async () => {
    const cookie = await sessionCookie(A, 'ADMIN');
    expect((await platformMiddleware(req('a.cliente.test', '/admin', { cookie }))).headers.get('x-middleware-next')).toBe('1');
    expect((await platformMiddleware(req('a.cliente.test', '/api/admin/orders', { cookie }))).headers.get('x-middleware-next')).toBe('1');
  });

  it('la cookie de ADMIN de A NO entra en B (secreto distinto)', async () => {
    const cookie = await sessionCookie(A, 'ADMIN');
    expect((await platformMiddleware(req('b.cliente.test', '/admin', { cookie }))).status).toBe(307);
    expect((await platformMiddleware(req('b.cliente.test', '/api/admin/orders', { cookie }))).status).toBe(401);
  });

  it('aunque la cookie estuviera firmada con el secreto de B pero llevara el tid de A, no entra (defensa en profundidad)', async () => {
    const cookie = await sessionCookie(B, 'ADMIN', { tid: A });
    expect((await platformMiddleware(req('b.cliente.test', '/admin', { cookie }))).status).toBe(307);
  });

  it('un cliente nuevo exige tid; la sesión sin tid solo vale para el legacy', async () => {
    expect((await platformMiddleware(req('a.cliente.test', '/admin', { cookie: await sessionCookie(A, 'ADMIN', { tid: null }) }))).status).toBe(307);
    const legacyCookie = await sessionCookie(env.LEGACY_TENANT_ID, 'ADMIN', { legacy: true, tid: null });
    expect((await platformMiddleware(req('legacy.cliente.test', '/admin', { cookie: legacyCookie }))).headers.get('x-middleware-next')).toBe('1');
  });

  it('subir la época de un cliente cierra sus sesiones (el secreto cambia) y no las de otros', async () => {
    const old = await sessionCookie(A, 'ADMIN', { epoch: 0 });
    const signer = await makeSigner();
    vi.stubEnv('SNAPSHOT_PUBKEYS', JSON.stringify({ [signer.kid]: signer.publicKey }));
    resetResolverStateForTests();
    await publishTenant(reg, signer, { tenantId: A, hosts: ['a.cliente.test'], master, epoch: 1 });
    expect((await platformMiddleware(req('a.cliente.test', '/admin', { cookie: old }))).status).toBe(307);
    expect((await platformMiddleware(req('a.cliente.test', '/admin', { cookie: await sessionCookie(A, 'ADMIN', { epoch: 1 }) }))).headers.get('x-middleware-next')).toBe('1');
  });

  it('TAQUILLA entra en /acceso y en las API de staff, pero no en /admin', async () => {
    const cookie = await sessionCookie(A, 'TAQUILLA');
    expect((await platformMiddleware(req('a.cliente.test', '/acceso', { cookie }))).headers.get('x-middleware-next')).toBe('1');
    expect((await platformMiddleware(req('a.cliente.test', '/api/scan', { method: 'POST', cookie, headers: { origin: 'http://a.cliente.test' } }))).headers.get('x-middleware-next')).toBe('1');
    expect((await platformMiddleware(req('a.cliente.test', '/admin', { cookie }))).status).toBe(307);
  });

  it('una sesión USER normal no entra en /admin', async () => {
    expect((await platformMiddleware(req('a.cliente.test', '/admin', { cookie: await sessionCookie(A, 'USER') }))).status).toBe(307);
  });
});

describe('Origin y caché', () => {
  it('rechaza una petición que modifica datos desde otro origen y deja pasar los webhooks', async () => {
    const evil = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    expect((await platformMiddleware(req('a.cliente.test', '/api/orders', { method: 'POST', headers: evil }))).status).toBe(403);
    expect((await platformMiddleware(req('a.cliente.test', '/api/webhooks/stripe', { method: 'POST', headers: evil }))).headers.get('x-middleware-next')).toBe('1');
  });

  it('las páginas públicas llevan la etiqueta de caché del cliente; el resto, no-store', async () => {
    const page = await platformMiddleware(req('a.cliente.test', '/eventos'));
    expect(page.headers.get('Vercel-Cache-Tag')).toBe(`t:${A}:public`);
    expect(page.headers.get('cache-control')).toBeNull();
    for (const path of ['/api/events', '/admin', '/auth/login']) {
      const res = await platformMiddleware(req('a.cliente.test', path, { cookie: await sessionCookie(A, 'ADMIN') }));
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('Vercel-Cache-Tag')).toBeNull();
    }
  });

  it('un POST a una página pública no se etiqueta para la caché', async () => {
    const res = await platformMiddleware(req('a.cliente.test', '/eventos', { method: 'POST', headers: { origin: 'http://a.cliente.test' } }));
    expect(res.headers.get('Vercel-Cache-Tag')).toBeNull();
  });
});
