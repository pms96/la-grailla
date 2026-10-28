import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { deriveInstallationSecret, generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { SESSION_COOKIE_HOST } from '@/lib/tenant/session-cookie';
import { platformMiddleware } from '@/lib/tenant/middleware';
import { resetResolverStateForTests, setRegistryReaderForTests } from '@/lib/tenant/resolve';
import { enablePlatformEnv } from '../helpers/platform';
import { FakeRegistry, makeSigner, publishTenant, type Signer } from '../helpers/registry';

/* Permisos por módulo en el borde: un administrador con un rol restringido solo entra en las rutas de SUS módulos. */

const T = '01HF7YAT00TTTTTTTTTTTTTTTT';
const NOW = 1_800_000_000_000;
const master = parseMasterKey(generateMasterKey());
let env: ReturnType<typeof enablePlatformEnv>;
let reg: FakeRegistry;
let signer: Signer;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  signer = await makeSigner();
  env = enablePlatformEnv({ SNAPSHOT_PUBKEYS: JSON.stringify({ [signer.kid]: signer.publicKey }) });
  reg = new FakeRegistry();
  resetResolverStateForTests();
  setRegistryReaderForTests(reg);
  await publishTenant(reg, signer, { tenantId: T, hosts: [host], master, now: NOW, modules: ['tienda', 'entradas', 'contabilidad', 'sponsors'] });
});
afterEach(() => {
  vi.useRealTimers();
  env.restore();
  setRegistryReaderForTests(null);
  resetResolverStateForTests();
});

const host = 'x.cliente.es';
const req = (path: string, cookie: string, method = 'GET') =>
  new NextRequest(`https://${host}${path}`, { method, headers: { host, origin: `https://${host}`, cookie } });

/** Cookie de sesión de ADMIN del cliente; `mods` ausente = propietario. */
async function adminCookie(mods?: string[]): Promise<string> {
  const secret = await deriveInstallationSecret(parseMasterKey(env.PLATFORM_SESSION_MASTER), T, 0, 'session');
  return `${SESSION_COOKIE_HOST}=${await encode({ token: { id: 'u1', role: 'ADMIN', tid: T, ...(mods ? { mods } : {}) }, secret })}`;
}
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('administrador con rol restringido (gestor de tienda)', () => {
  it('entra en lo de su módulo, en la configuración y en el inicio', async () => {
    const c = await adminCookie(['tienda']);
    for (const p of ['/admin', '/admin/productos', '/admin/configuracion', '/api/admin/products', '/api/admin/shop-orders', '/api/admin/shop-orders/export', '/api/admin/config']) {
      expect(passes(await platformMiddleware(req(p, c))), p).toBe(true);
    }
  });

  it('no entra en los demás módulos: la API da 403 y las páginas redirigen al inicio', async () => {
    const c = await adminCookie(['tienda']);
    for (const p of ['/api/admin/gastos', '/api/admin/events', '/api/admin/sponsors', '/api/admin/export']) {
      expect((await platformMiddleware(req(p, c))).status, p).toBe(403);
    }
    for (const p of ['/admin/gastos', '/admin/eventos']) {
      const res = await platformMiddleware(req(p, c));
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/admin');
    }
  });

  it('no puede gestionar usuarios ni roles: así no podría darse más permisos', async () => {
    const c = await adminCookie(['tienda', 'nucleo']);
    for (const p of ['/api/admin/users', '/api/admin/roles']) {
      expect((await platformMiddleware(req(p, c, 'POST'))).status, p).toBe(403);
    }
    expect((await platformMiddleware(req('/admin/usuarios', c))).status).toBe(307);
  });

  it('un rol sin ningún módulo (rol borrado o desconocido) no entra en ninguna pantalla de gestión', async () => {
    const c = await adminCookie([]);
    expect((await platformMiddleware(req('/api/admin/products', c))).status).toBe(403);
    expect(passes(await platformMiddleware(req('/admin', c)))).toBe(true);
  });
});

/* P1-03: la puerta y las APIs de personal fuera de /admin también son de un módulo (Entradas). Aquí se prueba con la sesión firmada, en el borde. */
describe('superficies de personal fuera de /admin (P1-03)', () => {
  const STAFF = [
    ['POST', '/api/taquilla/sale'],
    ['GET', '/api/taquilla/print-settings'],
    ['POST', '/api/invitations'],
    ['GET', '/api/invitations'],
    ['POST', '/api/guest-lists'],
    ['POST', '/api/scan'],
    ['GET', '/api/access/events'],
    ['GET', '/api/access/capacity'],
  ] as const;

  it('un gestor de tienda NO vende en taquilla, no emite invitaciones, no escanea y no entra en la puerta', async () => {
    const c = await adminCookie(['tienda']);
    for (const [m, p] of STAFF) expect((await platformMiddleware(req(p, c, m))).status, `${m} ${p}`).toBe(403);
    const door = await platformMiddleware(req('/acceso', c));
    expect(door.status).toBe(307);
    expect(new URL(door.headers.get('location')!).pathname).toBe('/admin');
  });

  it('lo mismo para un contable, un gestor de sponsors y el rol de contenido (núcleo)', async () => {
    for (const mods of [['contabilidad'], ['sponsors'], ['nucleo']]) {
      const c = await adminCookie(mods);
      for (const [m, p] of STAFF) expect((await platformMiddleware(req(p, c, m))).status, `${mods} ${m} ${p}`).toBe(403);
    }
  });

  it('un gestor de entradas SÍ entra en todas, y el propietario también', async () => {
    for (const c of [await adminCookie(['entradas', 'wallets']), await adminCookie()]) {
      for (const [m, p] of STAFF) expect(passes(await platformMiddleware(req(p, c, m))), `${m} ${p}`).toBe(true);
      expect(passes(await platformMiddleware(req('/acceso', c)))).toBe(true);
    }
  });

  it('el personal de puerta (TAQUILLA) no se ve afectado: no tiene rol por módulos', async () => {
    const secret = await deriveInstallationSecret(parseMasterKey(env.PLATFORM_SESSION_MASTER), T, 0, 'session');
    const cookie = `${SESSION_COOKIE_HOST}=${await encode({ token: { id: 'u2', role: 'TAQUILLA', tid: T }, secret })}`;
    for (const [m, p] of STAFF) expect(passes(await platformMiddleware(req(p, cookie, m))), `${m} ${p}`).toBe(true);
    expect(passes(await platformMiddleware(req('/acceso', cookie)))).toBe(true);
  });

  it('sin sesión, las invitaciones y las listas de invitados dan 401 en el borde (antes solo respondía su handler)', async () => {
    for (const p of ['/api/invitations', '/api/guest-lists']) {
      expect((await platformMiddleware(req(p, ''))).status, p).toBe(401);
    }
  });
});

describe('propietario (sin restricción)', () => {
  it('entra en todo lo de los módulos de su cliente, usuarios y roles incluidos', async () => {
    const c = await adminCookie();
    for (const p of ['/admin/gastos', '/api/admin/events', '/admin/usuarios', '/api/admin/users']) {
      expect(passes(await platformMiddleware(req(p, c))), p).toBe(true);
    }
  });
});
