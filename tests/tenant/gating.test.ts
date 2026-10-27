import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { deriveInstallationSecret, generateMasterKey, licensePhase, parseMasterKey, registryKeyForRevocation, type RoutingRecord } from '@grailla/contracts';
import { SESSION_COOKIE_HOST } from '@/lib/tenant/session-cookie';
import { gateByModuleAndLicense, platformMiddleware } from '@/lib/tenant/middleware';
import { CONTEXT_HEADER } from '@/lib/tenant/context';
import { verifyContext } from '@/lib/tenant/context-verify';
import { resetResolverStateForTests, setRegistryReaderForTests } from '@/lib/tenant/resolve';
import { enablePlatformEnv } from '../helpers/platform';
import { FakeRegistry, makeSigner, publishTenant, type Signer } from '../helpers/registry';

/* M5: módulos (default-deny) y fases de licencia en el middleware del modo plataforma. */

const T = '01HF7YAT00TTTTTTTTTTTTTTTT';
const DAY = 86_400_000;
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
});
afterEach(() => {
  vi.useRealTimers();
  env.restore();
  setRegistryReaderForTests(null);
  resetResolverStateForTests();
});

const host = 'x.cliente.es';
const publish = (over: { modules?: string[]; license?: RoutingRecord['license']; status?: RoutingRecord['status']; seq?: number; staleHours?: number } = {}) =>
  publishTenant(reg, signer, { tenantId: T, hosts: [host], master, now: NOW, modules: ['tienda', 'entradas'], ...over });
const req = (path: string, method = 'GET', cookie?: string) =>
  new NextRequest(`https://${host}${path}`, { method, headers: { host, origin: `https://${host}`, ...(cookie ? { cookie } : {}) } });
/** Cookie de sesión de ADMIN de este cliente (dominio real: prefijo __Host-). */
async function adminCookie(): Promise<string> {
  const secret = await deriveInstallationSecret(parseMasterKey(env.PLATFORM_SESSION_MASTER), T, 0, 'session');
  return `${SESSION_COOKIE_HOST}=${await encode({ token: { id: 'u1', role: 'ADMIN', tid: T }, secret })}`;
}
/** Cookie de sesión de staff (TAQUILLA, ADMIN...) de este cliente. */
async function staffCookie(role: 'ADMIN' | 'TAQUILLA'): Promise<string> {
  const secret = await deriveInstallationSecret(parseMasterKey(env.PLATFORM_SESSION_MASTER), T, 0, 'session');
  return `${SESSION_COOKIE_HOST}=${await encode({ token: { id: 'u1', role, tid: T }, secret })}`;
}
/** Ni cortada por módulo (404) ni por licencia (402/503): puede seguir pidiendo sesión de staff (401) y eso es otra capa. */
const notCut = (res: Response) => ![402, 404, 503].includes(res.status);
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1';
const rewrittenTo = (res: Response) => res.headers.get('x-middleware-rewrite');
const ctxOf = (res: Response) => {
  const raw = res.headers.get(`x-middleware-request-${CONTEXT_HEADER}`);
  return raw ? verifyContext(raw, parseMasterKey(env.PLATFORM_CONTEXT_KEY), Date.now()) : null;
};

describe('módulos: default-deny por ruta', () => {
  it('el núcleo siempre pasa; un módulo que el cliente tiene, también', async () => {
    await publish({ modules: ['tienda'] });
    for (const p of ['/', '/legal/privacidad', '/tienda', '/api/products']) expect(passes(await platformMiddleware(req(p))), p).toBe(true);
  });

  it('un módulo que el cliente NO tiene da 404 en páginas y en API', async () => {
    await publish({ modules: ['tienda'] });
    expect((await platformMiddleware(req('/eventos'))).status).toBe(404);
    expect((await platformMiddleware(req('/sponsors'))).status).toBe(404);
    const api = await platformMiddleware(req('/api/events'));
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'No encontrado' });
    expect((await platformMiddleware(req('/api/orders', 'POST'))).status).toBe(404);
  });

  it('wallets: un cliente sin el módulo no puede generar pases, ni siquiera con un GET de comprador', async () => {
    await publish({ modules: ['tienda'] });
    expect((await platformMiddleware(req('/api/wallet/apple/abc'))).status).toBe(404);
    reg.data.clear();
    resetResolverStateForTests();
    await publish({ modules: ['wallets', 'tienda'], seq: 2 });
    expect((await platformMiddleware(req('/api/wallet/apple/abc'))).status).not.toBe(404);
  });

  it('una ruta SIN dueño no existe (default-deny), aunque el cliente tenga todos los módulos', async () => {
    await publish({ modules: ['tienda', 'entradas', 'contabilidad', 'wallets', 'sponsors'] });
    expect((await platformMiddleware(req('/admin/pantalla-nueva'))).status).toBe(404);
    expect((await platformMiddleware(req('/api/endpoint-nuevo'))).status).toBe(404);
  });

  it('un módulo desconocido para este front se ignora (deny), no rompe nada', async () => {
    await publish({ modules: ['tienda', 'holograma'] });
    expect(passes(await platformMiddleware(req('/tienda')))).toBe(true);
    expect((await platformMiddleware(req('/eventos'))).status).toBe(404);
  });

  it('la allowlist pasa aunque el cliente no tenga el módulo (webhook, cron, validación de entradas)', async () => {
    await publish({ modules: [] });
    for (const [p, m] of [['/api/webhooks/stripe', 'POST'], ['/api/cron/reconcile-payments', 'GET'], ['/api/scan', 'POST']] as const) {
      expect((await platformMiddleware(req(p, m))).status, p).not.toBe(404);
    }
  });
});

describe('fases de licencia', () => {
  const license = (phase: 'ACTIVE' | 'GRACE' | 'PANEL_BLOCKED' | 'BLOCKED') => ({ phase, nextPhaseChangeAt: null });

  it('GRACE: todo sigue funcionando y el contexto lleva la fase (el admin muestra el aviso)', async () => {
    await publish({ license: license('GRACE') });
    const res = await platformMiddleware(req('/eventos'));
    expect(passes(res)).toBe(true);
    expect(ctxOf(res)?.license?.phase).toBe('GRACE');
  });

  it('PANEL_BLOCKED: sin /admin (402 en la API, aviso en las páginas); la web pública y las ventas siguen', async () => {
    await publish({ license: license('PANEL_BLOCKED') });
    const adminApi = await platformMiddleware(req('/api/admin/events'));
    expect(adminApi.status).toBe(402);
    expect(await adminApi.json()).toEqual({ error: 'Licencia vencida' });
    // Sin sesión, /admin va al login (como siempre); con sesión de ADMIN se ve el aviso en lugar del panel.
    expect((await platformMiddleware(req('/admin/eventos'))).status).toBe(307);
    const page = await platformMiddleware(req('/admin/eventos', 'GET', await adminCookie()));
    expect(page.status).toBe(402);
    expect(new URL(rewrittenTo(page)!).pathname).toBe('/licencia');
    for (const [p, m] of [['/', 'GET'], ['/eventos', 'GET'], ['/tienda', 'GET'], ['/api/orders', 'POST'], ['/api/shop/orders', 'POST']] as const) {
      expect(passes(await platformMiddleware(req(p, m))), p).toBe(true);
    }
    expect(passes(await platformMiddleware(req('/auth/login')))).toBe(true);
  });

  it('BLOCKED: todo cortado salvo la allowlist y el login', async () => {
    await publish({ license: license('BLOCKED') });
    const home = await platformMiddleware(req('/'));
    expect(home.status).toBe(503);
    expect(new URL(rewrittenTo(home)!).pathname).toBe('/licencia');
    expect((await platformMiddleware(req('/api/orders', 'POST'))).status).toBe(503);
    expect((await platformMiddleware(req('/api/taquilla/sale', 'POST'))).status).toBe(503);
    expect((await platformMiddleware(req('/api/admin/events'))).status).toBe(503);
    // lo que no se corta nunca
    for (const [p, m] of [
      ['/api/webhooks/stripe', 'POST'],
      ['/api/cron/reconcile-payments', 'GET'],
      ['/api/scan', 'POST'],
      ['/api/access/capacity', 'GET'],
      ['/api/access/events', 'GET'],
      ['/acceso', 'GET'],
      ['/confirmacion/abc', 'GET'],
      ['/api/orders/abc', 'GET'],
      ['/api/tickets/abc/pdf-html', 'GET'],
      ['/auth/login', 'GET'],
      ['/licencia', 'GET'],
    ] as const) {
      expect(notCut(await platformMiddleware(req(p, m))), p).toBe(true);
    }
  });

  it('la fase avanza sola por el calendario del snapshot, sin que el panel republique (lectura fresca)', async () => {
    // Plazos cortos para que todo ocurra dentro de las 168 h de vida del snapshot.
    const terms = { paidThrough: NOW + 1 * DAY, graceDays: 2, panelBlockedDays: 3 };
    await publish({ license: licensePhase(terms, NOW) });
    expect(ctxOf(await platformMiddleware(req('/eventos')))?.license?.phase).toBe('ACTIVE');

    vi.setSystemTime(NOW + 2 * DAY); // dentro de la gracia
    expect(ctxOf(await platformMiddleware(req('/eventos')))?.license?.phase).toBe('GRACE');

    vi.setSystemTime(NOW + 3.5 * DAY); // PANEL_BLOCKED desde el día 3
    expect((await platformMiddleware(req('/api/admin/events'))).status).toBe(402);

    vi.setSystemTime(NOW + 6.5 * DAY); // BLOCKED desde el día 6
    expect((await platformMiddleware(req('/'))).status).toBe(503);
  });

  it('con el registro caído un snapshot obsoleto NO empeora la fase (el cliente pudo pagar y no verse)', async () => {
    const terms = { paidThrough: NOW + 3_600_000, graceDays: 0, panelBlockedDays: 0 }; // BLOCKED a la hora
    await publish({ license: licensePhase(terms, NOW) });
    await platformMiddleware(req('/eventos')); // calienta la caché
    reg.failWith = new Error('registro caído');
    vi.setSystemTime(NOW + 2 * 3_600_000);
    const res = await platformMiddleware(req('/eventos'));
    expect(passes(res)).toBe(true);
    expect(ctxOf(res)?.license?.phase).toBe('ACTIVE');
  });

  it('un snapshot que ha pasado su `staleUntil` tampoco empeora la fase: el panel debe refrescarlos (no puede cobrar a quien no puede registrar su pago)', async () => {
    const terms = { paidThrough: NOW + 1 * DAY, graceDays: 2, panelBlockedDays: 3 };
    await publish({ license: licensePhase(terms, NOW), staleHours: 48 });
    vi.setSystemTime(NOW + 6.5 * DAY); // el registro responde, pero el snapshot es de hace 6 días y caducó a las 48 h
    expect(passes(await platformMiddleware(req('/')))).toBe(true);
  });

  it('el pago llega con un snapshot nuevo: la fase mejora', async () => {
    await publish({ license: license('PANEL_BLOCKED'), seq: 1 });
    expect((await platformMiddleware(req('/api/admin/events'))).status).toBe(402);
    await publish({ license: license('ACTIVE'), seq: 2 });
    vi.setSystemTime(NOW + 20_000); // pasa la caché L1
    expect(passes(await platformMiddleware(req('/eventos')))).toBe(true);
  });
});

describe('revisión de seguridad de M5', () => {
  it('con el snapshot obsoleto la fase NO parpadea entre peticiones (aciertos de L1 incluidos)', async () => {
    const terms = { paidThrough: NOW - 10 * DAY, graceDays: 1, panelBlockedDays: 1 }; // ya debería estar BLOCKED
    await publish({ license: licensePhase({ ...terms, paidThrough: NOW + 3_600_000 }, NOW), staleHours: 1 });
    vi.setSystemTime(NOW + 3 * 3_600_000); // pasó el staleUntil y el calendario diría BLOCKED
    const phases: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      phases.push(ctxOf(await platformMiddleware(req('/eventos')))?.license?.phase);
      vi.setSystemTime(NOW + 3 * 3_600_000 + (i + 1) * 4_000); // dentro y a caballo de la ventana de L1
    }
    expect(new Set(phases)).toEqual(new Set(['ACTIVE']));
  });

  it('PANEL_BLOCKED también bloquea las APIs de gestión de invitaciones; la taquilla y el escáner siguen', async () => {
    await publish({ license: { phase: 'PANEL_BLOCKED', nextPhaseChangeAt: null } });
    expect((await platformMiddleware(req('/api/invitations', 'POST'))).status).toBe(402);
    expect((await platformMiddleware(req('/api/guest-lists'))).status).toBe(402);
    expect(await (await platformMiddleware(req('/api/invitations', 'POST'))).json()).toEqual({ error: 'Licencia vencida' });
    expect((await platformMiddleware(req('/api/taquilla/sale', 'POST'))).status).not.toBe(402);
    expect((await platformMiddleware(req('/api/scan', 'POST'))).status).not.toBe(402);
  });

  it('con el calendario agotado no se anuncia un «próximo cambio» pasado', async () => {
    await publish({ license: { phase: 'GRACE', nextPhaseChangeAt: NOW - DAY, schedule: [{ at: NOW - DAY, phase: 'GRACE' }] } });
    const res = await platformMiddleware(req('/eventos'));
    expect(ctxOf(res)?.license).toMatchObject({ phase: 'GRACE', nextPhaseChangeAt: null });
  });
});

/* P0-03 / EN-03 / MO-05: en la puerta de un evento hay que seguir validando entradas YA vendidas aunque el cliente esté en BLOCKED o con el
 * módulo Entradas apagado. Solo se cortan las VENTAS nuevas; nada se abre a anónimos ni a otras rutas. Una SUSPENSIÓN (y la revocación de
 * emergencia, que llega como SUSPENDED) corta TODO, también la puerta. */
describe('la puerta del evento (escáner): abierta en todas las fases y con Entradas apagado; cerrada si el cliente está suspendido', () => {
  type Phase = 'ACTIVE' | 'GRACE' | 'PANEL_BLOCKED' | 'BLOCKED';
  const PHASES: Phase[] = ['ACTIVE', 'GRACE', 'PANEL_BLOCKED', 'BLOCKED'];
  const door = [
    ['/acceso', 'GET'],
    ['/api/access/events', 'GET'],
    ['/api/access/capacity', 'GET'],
  ] as const;
  const origin = { origin: `https://${host}` };
  const reqWithOrigin = (path: string, method: string, cookie: string) =>
    new NextRequest(`https://${host}${path}`, { method, headers: { host, ...origin, cookie } });

  for (const modules of [['tienda', 'entradas'], ['tienda']]) {
    const label = modules.includes('entradas') ? 'con Entradas' : 'con Entradas APAGADO';
    for (const phase of PHASES) {
      it(`${phase} ${label}: staff entra en /acceso, en la lista de eventos y en el escáner`, async () => {
        await publish({ modules, license: { phase, nextPhaseChangeAt: null } });
        for (const role of ['TAQUILLA', 'ADMIN'] as const) {
          const cookie = await staffCookie(role);
          for (const [p, m] of door) expect(passes(await platformMiddleware(req(p, m, cookie))), `${role} ${p}`).toBe(true);
          expect(passes(await platformMiddleware(reqWithOrigin('/api/scan', 'POST', cookie))), `${role} /api/scan`).toBe(true);
        }
      });

      it(`${phase} ${label}: sigue cerrado a anónimos (login en la página, 401 en la API)`, async () => {
        await publish({ modules, license: { phase, nextPhaseChangeAt: null } });
        const page = await platformMiddleware(req('/acceso'));
        expect(page.status).toBe(307);
        expect(new URL(page.headers.get('location')!).pathname).toBe('/auth/login');
        for (const p of ['/api/access/events', '/api/access/capacity']) expect((await platformMiddleware(req(p))).status, p).toBe(401);
        expect((await platformMiddleware(req('/api/scan', 'POST'))).status).toBe(401);
        // Un USER normal no es staff: tampoco entra.
        const secret = await deriveInstallationSecret(parseMasterKey(env.PLATFORM_SESSION_MASTER), T, 0, 'session');
        const user = `${SESSION_COOKIE_HOST}=${await encode({ token: { id: 'u2', role: 'USER', tid: T }, secret })}`;
        expect((await platformMiddleware(req('/acceso', 'GET', user))).status).toBe(307);
        expect((await platformMiddleware(req('/api/access/events', 'GET', user))).status).toBe(401);
      });
    }
  }

  it('las VENTAS nuevas se siguen cortando en BLOCKED (y la taquilla y el panel, según la fase) aunque la puerta esté abierta', async () => {
    await publish({ license: { phase: 'BLOCKED', nextPhaseChangeAt: null } });
    const cookie = await staffCookie('TAQUILLA');
    expect(passes(await platformMiddleware(req('/acceso', 'GET', cookie)))).toBe(true);
    for (const [p, m] of [['/api/orders', 'POST'], ['/api/shop/orders', 'POST'], ['/api/taquilla/sale', 'POST'], ['/api/events', 'GET'], ['/eventos', 'GET'], ['/api/invitations', 'GET']] as const) {
      expect((await platformMiddleware(reqWithOrigin(p, m, cookie))).status, p).toBe(503);
    }
  });

  it('PANEL_BLOCKED: la puerta sigue, pero invitaciones y panel (también /admin/noche) se cortan; las ventas siguen', async () => {
    await publish({ license: { phase: 'PANEL_BLOCKED', nextPhaseChangeAt: null } });
    const cookie = await staffCookie('ADMIN');
    expect(passes(await platformMiddleware(req('/acceso', 'GET', cookie)))).toBe(true);
    expect((await platformMiddleware(req('/api/guest-lists', 'GET', cookie))).status).toBe(402);
    expect((await platformMiddleware(req('/admin/noche', 'GET', cookie))).status).toBe(402);
    expect(passes(await platformMiddleware(reqWithOrigin('/api/orders', 'POST', cookie)))).toBe(true);
  });

  it('Entradas apagado: las ventas y la web de eventos dan 404, la puerta no', async () => {
    await publish({ modules: ['tienda'] });
    const cookie = await staffCookie('TAQUILLA');
    for (const [p, m] of [['/eventos', 'GET'], ['/api/events', 'GET'], ['/api/orders', 'POST'], ['/api/taquilla/sale', 'POST']] as const) {
      expect((await platformMiddleware(reqWithOrigin(p, m, cookie))).status, p).toBe(404);
    }
    expect(passes(await platformMiddleware(req('/acceso', 'GET', cookie)))).toBe(true);
  });

  it('cliente SUSPENDIDO (incluye revocación de emergencia), PENDING_DELETION y DELETED: se corta TODO, también la puerta, aunque haya sesión de staff', async () => {
    for (const [i, status] of (['SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const).entries()) {
      reg.data.clear();
      resetResolverStateForTests();
      await publish({ status, seq: i + 1, license: { phase: 'BLOCKED', nextPhaseChangeAt: null } });
      for (const role of ['TAQUILLA', 'ADMIN'] as const) {
        const cookie = await staffCookie(role);
        for (const [p, m] of door) expect((await platformMiddleware(req(p, m, cookie))).status, `${status} ${role} ${p}`).toBe(503);
        expect((await platformMiddleware(reqWithOrigin('/api/scan', 'POST', cookie))).status, `${status} ${role} /api/scan`).toBe(503);
      }
      // anónimos: tampoco (503, no login ni 401)
      expect((await platformMiddleware(req('/acceso'))).status).toBe(503);
      expect((await platformMiddleware(req('/api/access/events'))).status).toBe(503);
      // y el login también; lo único que sigue es lo de siempre
      expect((await platformMiddleware(req('/auth/login'))).status).toBe(503);
      expect(passes(await platformMiddleware(req('/api/webhooks/stripe', 'POST')))).toBe(true);
    }
  });

  it('no se abre ningún otro prefijo: solo GET de /acceso exacto, y ni subrutas ni otros métodos ni vecinos', async () => {
    await publish({ license: { phase: 'BLOCKED', nextPhaseChangeAt: null } });
    const cookie = await staffCookie('ADMIN');
    for (const [p, m] of [
      ['/acceso/otra', 'GET'],
      ['/acceso-viejo', 'GET'],
      ['/acceso', 'POST'],
      ['/api/events/algo', 'GET'],
      ['/api/accesox', 'GET'],
      ['/api/admin/scans', 'GET'],
      ['/api/admin/noche', 'GET'],
      ['/api/taquilla/print/abc', 'GET'],
      ['/api/guest-lists', 'GET'],
    ] as const) {
      expect([404, 503], `${m} ${p}`).toContain((await platformMiddleware(reqWithOrigin(p, m, cookie))).status);
    }
  });
});

describe('revocación de emergencia en el middleware', () => {
  it('corta al cliente en segundos, salvo webhooks y crons, sin republicar', async () => {
    await publish();
    expect(passes(await platformMiddleware(req('/eventos')))).toBe(true);
    reg.data.set(registryKeyForRevocation(T), '1');
    vi.setSystemTime(NOW + 6_000);
    expect((await platformMiddleware(req('/eventos'))).status).toBe(503);
    expect((await platformMiddleware(req('/api/orders', 'POST'))).status).toBe(503);
    expect(passes(await platformMiddleware(req('/api/webhooks/stripe', 'POST')))).toBe(true);
  });
});

describe('gateByModuleAndLicense (función pura)', () => {
  it('robots.txt y sitemap.xml en BLOCKED no se reescriben a una página HTML', () => {
    const gate = gateByModuleAndLicense('/robots.txt', 'GET', [], 'BLOCKED');
    expect(gate).toMatchObject({ kind: 'api', status: 503 });
  });
});
