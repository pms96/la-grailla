import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { POST as createShopOrder } from '@/app/api/shop/orders/route';
import { POST as joinQueue } from '@/app/api/queue/join/route';
import { CAPTCHA_SECRET_KEY, CAPTCHA_SITE_KEY, getCaptchaSiteKey, resetCaptchaReportThrottle, verifyCaptcha } from '@/lib/captcha';
import { isWriteOnlyConfigKey } from '@/lib/secrets';
import { configKeyOwners } from '@/lib/config-ownership';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/observability/capture', () => ({ captureOpsError: capture, safeTenantId: () => null }));
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return {
    ...actual,
    getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)),
    getPaymentProvider: async (s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProvider(s)),
  };
});
vi.mock('@/lib/mailer', async (orig) => ({ ...(await orig<typeof import('@/lib/mailer')>()), sendMail: async () => ({ success: true, transport: 'smtp' as const }) }));

/* Captcha (Turnstile) en el pedido de entradas, el de la tienda y la entrada a la sala de espera. Cloudflare se simula: ningún test sale a la red. */

const SITE = '0x4AAAA-test-site';
const SECRET = '0x4AAAA-test-secret';
const runId = Math.floor(Math.random() * 60_000);
let ipCounter = 0;
const freshIp = () => `10.${runId >> 8}.${runId & 255}.${(ipCounter += 1)}`;

const req = (url: string, body: unknown, ip = freshIp()) =>
  new Request(`http://localhost${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

type Verdict = { success: boolean; 'error-codes'?: string[]; action?: string };
/** Simula `siteverify`: `verdict` por defecto es éxito; devuelve las llamadas recibidas. */
function fakeSiteverify(verdict: Verdict | (() => Response | Promise<Response>) = { success: true }) {
  const calls: { secret: string; response: string; remoteip: string }[] = [];
  // `spyOn` sobre algo ya espiado devuelve el mismo espía con sus llamadas anteriores: se limpia para contar solo las de esta simulación.
  const spy = vi.spyOn(globalThis, 'fetch').mockClear().mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) throw new Error(`fetch inesperado: ${url}`);
    calls.push(JSON.parse(String(init?.body)));
    if (typeof verdict === 'function') return verdict();
    return new Response(JSON.stringify(verdict), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { calls, spy };
}

describe('captcha: verificación en el servidor', () => {
  let origSite: string | null;
  let origSecret: string | null;
  beforeAll(async () => {
    origSite = await getAndSetConfig(CAPTCHA_SITE_KEY, '');
    origSecret = await getAndSetConfig(CAPTCHA_SECRET_KEY, '');
  });
  afterAll(async () => {
    await restoreConfig(CAPTCHA_SITE_KEY, origSite);
    await restoreConfig(CAPTCHA_SECRET_KEY, origSecret);
  });
  beforeEach(() => {
    capture.mockClear();
    resetCaptchaReportThrottle();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const enable = async () => {
    await getAndSetConfig(CAPTCHA_SITE_KEY, SITE);
    await getAndSetConfig(CAPTCHA_SECRET_KEY, SECRET);
  };
  const disable = async () => {
    await getAndSetConfig(CAPTCHA_SITE_KEY, '');
    await getAndSetConfig(CAPTCHA_SECRET_KEY, '');
  };
  const verify = (token: unknown, action: 'order' | 'shop-order' | 'queue' = 'order') => verifyCaptcha(req('/api/orders', {}), token, action);

  it('las claves son del núcleo y la secreta es de solo escritura (cifrada y enmascarada en el admin)', () => {
    expect(configKeyOwners(CAPTCHA_SITE_KEY)).toEqual(['nucleo']);
    expect(configKeyOwners(CAPTCHA_SECRET_KEY)).toEqual(['nucleo']);
    expect(isWriteOnlyConfigKey(CAPTCHA_SECRET_KEY)).toBe(true);
    expect(isWriteOnlyConfigKey(CAPTCHA_SITE_KEY)).toBe(false);
  });

  it('sin claves está desactivado: no se llama a Cloudflare, no se exige token y no se pinta el widget', async () => {
    await disable();
    const { spy } = fakeSiteverify();
    expect(await verify(undefined)).toEqual({ ok: true, skipped: 'disabled' });
    expect(spy).not.toHaveBeenCalled();
    expect(await getCaptchaSiteKey()).toBe('');
  });

  it('con solo una de las dos claves sigue desactivado (media configuración no bloquea ventas)', async () => {
    await getAndSetConfig(CAPTCHA_SITE_KEY, SITE);
    await getAndSetConfig(CAPTCHA_SECRET_KEY, '');
    const { spy } = fakeSiteverify();
    expect(await verify(undefined)).toEqual({ ok: true, skipped: 'disabled' });
    expect(spy).not.toHaveBeenCalled();
    expect(await getCaptchaSiteKey()).toBe('');
  });

  it('la clave del sitio SIN secreta (a medias, o secreta que no se descifra) no actúa pero AVISA en vez de apagarse en silencio', async () => {
    await getAndSetConfig(CAPTCHA_SITE_KEY, SITE);
    await getAndSetConfig(CAPTCHA_SECRET_KEY, '');
    const { spy } = fakeSiteverify();
    expect(await verify('tok')).toEqual({ ok: true, skipped: 'disabled' });
    expect(spy).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('si la BD falla al leer la configuración, el captcha NO se apaga en silencio: se deja pasar y se avisa', async () => {
    await enable();
    vi.spyOn(prisma.appConfig, 'findMany').mockRejectedValueOnce(new Error('pool agotado'));
    expect(await verify('tok')).toEqual({ ok: true, skipped: 'unavailable' });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await getCaptchaSiteKey()).toBe(SITE); // y la lectura siguiente funciona con normalidad
  });

  it('un rechazo del token manda sobre un fallo de servicio que venga a la vez (un token malo nunca pasa)', async () => {
    await enable();
    fakeSiteverify({ success: false, 'error-codes': ['internal-error', 'invalid-input-response'] });
    expect(await verify('tok')).toEqual({ ok: false, code: 'captcha_failed' });
    fakeSiteverify({ success: false, 'error-codes': ['invalid-input-secret', 'timeout-or-duplicate'] });
    expect(await verify('tok')).toEqual({ ok: false, code: 'captcha_failed' });
  });

  it('sin IP conocida no se manda `remoteip` (Cloudflare lo trataría como petición mal formada)', async () => {
    await enable();
    const { calls } = fakeSiteverify({ success: true });
    await verifyCaptcha(new Request('http://localhost/api/orders', { method: 'POST', body: '{}' }), 'tok', 'order');
    expect(calls).toEqual([{ secret: SECRET, response: 'tok' }]);
  });

  it('con las dos claves, la página recibe SOLO la clave pública', async () => {
    await enable();
    expect(await getCaptchaSiteKey()).toBe(SITE);
  });

  it('sin token (o vacío) es captcha_required y ni se llama a Cloudflare', async () => {
    await enable();
    const { spy } = fakeSiteverify();
    expect(await verify(undefined)).toEqual({ ok: false, code: 'captcha_required' });
    expect(await verify('   ')).toEqual({ ok: false, code: 'captcha_required' });
    expect(await verify(12345)).toEqual({ ok: false, code: 'captcha_required' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('un token válido pasa y a Cloudflare solo viaja el secreto, el token y la IP', async () => {
    await enable();
    const { calls } = fakeSiteverify({ success: true, action: 'order' });
    const r = await verifyCaptcha(req('/api/orders', {}, '203.0.113.9'), 'tok-1', 'order');
    expect(r).toEqual({ ok: true, skipped: null });
    expect(calls).toEqual([{ secret: SECRET, response: 'tok-1', remoteip: '203.0.113.9' }]);
  });

  it.each(['invalid-input-response', 'timeout-or-duplicate', 'missing-input-response', 'bad-request'])('Cloudflare rechaza el token (%s): captcha_failed, falla cerrado', async (code) => {
    await enable();
    fakeSiteverify({ success: false, 'error-codes': [code] });
    expect(await verify('tok')).toEqual({ ok: false, code: 'captcha_failed' });
    expect(capture).not.toHaveBeenCalled(); // un comprador rechazado no es una incidencia nuestra
  });

  it('un token sacado para otra acción no vale (el de la cola no sirve para pedir entradas)', async () => {
    await enable();
    fakeSiteverify({ success: true, action: 'queue' });
    expect(await verify('tok', 'order')).toEqual({ ok: false, code: 'captcha_failed' });
    fakeSiteverify({ success: true, action: 'queue' });
    expect(await verify('tok', 'queue')).toEqual({ ok: true, skipped: null });
  });

  it('un token absurdamente largo se rechaza sin llamar a Cloudflare', async () => {
    await enable();
    const { spy } = fakeSiteverify();
    expect(await verify('x'.repeat(2049))).toEqual({ ok: false, code: 'captcha_failed' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('si Cloudflare no responde o da error, la venta NO se cierra (falla abierto) y se avisa', async () => {
    await enable();
    fakeSiteverify(() => {
      throw new Error('ECONNRESET');
    });
    expect(await verify('tok')).toEqual({ ok: true, skipped: 'unavailable' });
    expect(capture).toHaveBeenCalledTimes(1);
    fakeSiteverify(() => new Response('boom', { status: 503 }));
    resetCaptchaReportThrottle();
    expect(await verify('tok')).toEqual({ ok: true, skipped: 'unavailable' });
  });

  it('un secreto mal puesto o un fallo interno de Cloudflare tampoco cierran la venta', async () => {
    await enable();
    fakeSiteverify({ success: false, 'error-codes': ['invalid-input-secret'] });
    expect(await verify('tok')).toEqual({ ok: true, skipped: 'unavailable' });
    resetCaptchaReportThrottle();
    fakeSiteverify({ success: false, 'error-codes': ['internal-error'] });
    expect(await verify('tok')).toEqual({ ok: true, skipped: 'unavailable' });
  });

  it('con Cloudflare caído en plena venta, el aviso a Sentry sale una vez, no una por pedido', async () => {
    await enable();
    fakeSiteverify(() => new Response('', { status: 502 }));
    for (let i = 0; i < 5; i++) await verify('tok');
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe('captcha: endpoints', () => {
  let origSite: string | null;
  let origSecret: string | null;
  let origCap: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const productIds: string[] = [];

  beforeAll(async () => {
    origSite = await getAndSetConfig(CAPTCHA_SITE_KEY, SITE);
    origSecret = await getAndSetConfig(CAPTCHA_SECRET_KEY, SECRET);
    origCap = await getAndSetConfig('orders_max_pending_per_ip', '1000');
    event = await createTestEvent({ maxCapacity: 500 });
    tt = await createTicketType(event.id, { maxQuantity: 500 });
  });
  afterAll(async () => {
    await restoreConfig(CAPTCHA_SITE_KEY, origSite);
    await restoreConfig(CAPTCHA_SECRET_KEY, origSecret);
    await restoreConfig('orders_max_pending_per_ip', origCap);
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await prisma.waitingRoomEntry.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'pending:' } } });
  });
  beforeEach(async () => {
    gateway.reset();
    gateway.active = true;
    capture.mockClear();
    resetCaptchaReportThrottle();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.ticketType.updateMany({ where: { eventId: event.id }, data: { soldCount: 0 } });
    await prisma.event.update({ where: { id: event.id }, data: { waitingRoomEnabled: false } });
    await prisma.waitingRoomEntry.deleteMany({ where: { eventId: event.id } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'pending:' } } });
  });
  afterEach(() => vi.restoreAllMocks());

  const orderBody = (over: Record<string, unknown> = {}) => ({
    eventId: event.id, buyerName: 'Ana', buyerLastName: 'López', buyerEmail: `ana-${Math.random()}@example.com`,
    items: [{ ticketTypeId: tt.id, quantity: 1 }], acceptedTerms: true, ...over,
  });
  const orders = () => prisma.order.count({ where: { eventId: event.id } });

  describe('pedido de entradas', () => {
    it('sin token: 400 captcha_required y no se crea ningún pedido', async () => {
      const { spy } = fakeSiteverify();
      const res = await createOrder(req('/api/orders', orderBody()));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'captcha_required' });
      expect(spy).not.toHaveBeenCalled();
      expect(await orders()).toBe(0);
    });

    it('token rechazado por Cloudflare: 400 captcha_failed y no se crea ningún pedido', async () => {
      fakeSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
      const res = await createOrder(req('/api/orders', orderBody({ captchaToken: 'gastado' })));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'captcha_failed' });
      expect(await orders()).toBe(0);
    });

    it('con token válido se crea el pedido', async () => {
      const { calls } = fakeSiteverify({ success: true, action: 'order' });
      const res = await createOrder(req('/api/orders', orderBody({ captchaToken: 'bueno' })));
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(await orders()).toBe(1);
    });

    it('un bot rechazado no deja pedido ni gasta aforo', async () => {
      fakeSiteverify({ success: false, 'error-codes': ['invalid-input-response'] });
      await createOrder(req('/api/orders', orderBody({ captchaToken: 'malo' })));
      expect((await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).soldCount).toBe(0);
    });

    it('con Cloudflare caído se sigue vendiendo', async () => {
      fakeSiteverify(() => new Response('', { status: 503 }));
      const res = await createOrder(req('/api/orders', orderBody({ captchaToken: 'x' })));
      expect(res.status).toBe(200);
    });

    it('con sala de espera, quien tiene turno ADMITIDO no resuelve un segundo captcha (ya lo pasó al entrar)', async () => {
      await prisma.event.update({ where: { id: event.id }, data: { waitingRoomEnabled: true } });
      const entry = await prisma.waitingRoomEntry.create({
        data: { eventId: event.id, token: `adm-${Math.random()}`, status: 'ADMITTED', admittedAt: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000), ip: '203.0.113.200' },
      });
      const { spy } = fakeSiteverify();
      const res = await createOrder(req('/api/orders', orderBody({ queueToken: entry.token })));
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    });

    it('si el admin APAGA la cola a media venta, un comprador con turno ADMITIDO tiene que poder pasar el captcha (y sin él, no)', async () => {
      const entry = await prisma.waitingRoomEntry.create({
        data: { eventId: event.id, token: `adm-${Math.random()}`, status: 'ADMITTED', admittedAt: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000), ip: '203.0.113.202' },
      });
      fakeSiteverify({ success: true, action: 'order' });
      const sin = await createOrder(req('/api/orders', orderBody({ queueToken: entry.token })));
      expect(sin.status).toBe(400);
      expect(await sin.json()).toMatchObject({ code: 'captcha_required' });
      const con = await createOrder(req('/api/orders', orderBody({ queueToken: entry.token, captchaToken: 'bueno' })));
      expect(con.status).toBe(200);
    });

    it('con sala de espera y sin turno válido sigue siendo 403 (el captcha no sustituye a la cola)', async () => {
      await prisma.event.update({ where: { id: event.id }, data: { waitingRoomEnabled: true } });
      fakeSiteverify();
      const res = await createOrder(req('/api/orders', orderBody({ captchaToken: 'bueno' })));
      expect(res.status).toBe(403);
    });

    it('un reintento idempotente de un pedido que ya existe no pide otro captcha', async () => {
      fakeSiteverify({ success: true });
      const body = orderBody({ captchaToken: 'bueno', idempotencyKey: `idem-${Math.random()}` });
      expect((await createOrder(req('/api/orders', body))).status).toBe(200);
      const { spy } = fakeSiteverify();
      expect((await createOrder(req('/api/orders', { ...body, captchaToken: undefined }))).status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      expect(await orders()).toBe(1);
    });
  });

  describe('pedido de la tienda', () => {
    const shopBody = (productId: string, over: Record<string, unknown> = {}) => ({
      buyerName: 'Luis', buyerEmail: `luis-${Math.random()}@example.com`, shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001',
      acceptedTerms: true, items: [{ productId, quantity: 1, size: 'M' }], ...over,
    });
    const product = async () => {
      const p = await prisma.product.create({ data: { name: 'Captcha', slug: `captcha-${Date.now()}-${Math.random()}`, price: 10, variants: { create: { size: 'M', color: '', stock: 50 } } } });
      productIds.push(p.id);
      return p.id;
    };

    it('sin token: 400 captcha_required y no se reserva stock', async () => {
      const id = await product();
      fakeSiteverify();
      const res = await createShopOrder(req('/api/shop/orders', shopBody(id)));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'captcha_required' });
      expect(await prisma.shopOrder.count({ where: { items: { some: { productId: id } } } })).toBe(0);
    });

    it('con token válido de su acción se crea; con el token de otra acción no', async () => {
      const id = await product();
      fakeSiteverify({ success: true, action: 'order' });
      expect((await createShopOrder(req('/api/shop/orders', shopBody(id, { captchaToken: 'de-otra-accion' })))).status).toBe(400);
      fakeSiteverify({ success: true, action: 'shop-order' });
      expect((await createShopOrder(req('/api/shop/orders', shopBody(id, { captchaToken: 'bueno' })))).status).toBe(200);
    });
  });

  describe('sala de espera (queue/join)', () => {
    const queueEvent = async () => {
      await prisma.event.update({ where: { id: event.id }, data: { waitingRoomEnabled: true, waitingRoomConcurrentSlots: 5, waitingRoomPurchaseWindowSeconds: 300 } });
    };

    it('entrar en la cola sin token da 400 captcha_required y no crea turno', async () => {
      await queueEvent();
      fakeSiteverify();
      const res = await joinQueue(req('/api/queue/join', { eventId: event.id }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'captcha_required' });
      expect(await prisma.waitingRoomEntry.count({ where: { eventId: event.id } })).toBe(0);
    });

    it('con token válido entra; y seguir en la cola con su turno ya no pide captcha', async () => {
      await queueEvent();
      fakeSiteverify({ success: true, action: 'queue' });
      const first = await joinQueue(req('/api/queue/join', { eventId: event.id, captchaToken: 'bueno' }));
      expect(first.status).toBe(200);
      const { token } = await first.json();
      expect(token).toBeTruthy();

      const { spy } = fakeSiteverify();
      const again = await joinQueue(req('/api/queue/join', { eventId: event.id, token }));
      expect(again.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      expect(await prisma.waitingRoomEntry.count({ where: { eventId: event.id } })).toBe(1);
    });

    it('quien ya está al tope de turnos vivos de su IP recibe 429 SIN gastar un token (no se le pide otro captcha en bucle)', async () => {
      await queueEvent();
      const ip = '203.0.113.210';
      for (let i = 0; i < 3; i++) await prisma.waitingRoomEntry.create({ data: { eventId: event.id, token: `live-${i}-${Math.random()}`, status: 'WAITING', ip } });
      const { spy } = fakeSiteverify();
      const res = await joinQueue(req('/api/queue/join', { eventId: event.id, captchaToken: 'bueno' }, ip));
      expect(res.status).toBe(429);
      expect(spy).not.toHaveBeenCalled();
      const sinToken = await joinQueue(req('/api/queue/join', { eventId: event.id }, ip));
      expect(sinToken.status).toBe(429); // y tampoco `captcha_required`: no hay widget que resolver
    });

    it('un turno CADUCADO que vuelve a entrar sí tiene que pasar el captcha otra vez', async () => {
      await queueEvent();
      const old = await prisma.waitingRoomEntry.create({ data: { eventId: event.id, token: `exp-${Math.random()}`, status: 'EXPIRED', ip: '203.0.113.201' } });
      fakeSiteverify();
      const res = await joinQueue(req('/api/queue/join', { eventId: event.id, token: old.token }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'captcha_required' });
    });

    it('con la cola desactivada no se pide captcha (no hay turno que proteger)', async () => {
      const { spy } = fakeSiteverify();
      const res = await joinQueue(req('/api/queue/join', { eventId: event.id }));
      expect((await res.json()).status).toBe('ADMITTED');
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
