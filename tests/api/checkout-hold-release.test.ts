import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as cron } from '@/app/api/cron/reconcile-payments/route';
import { GET as abandonOrder, HEAD as headOrder } from '@/app/api/orders/[orderId]/abandon/route';
import { GET as abandonShopOrder, HEAD as headShopOrder } from '@/app/api/shop/orders/[orderId]/abandon/route';
import { signOrderAccess, signShopOrderAccess } from '@/lib/access-token';
import { CHECKOUT_HOLD_MINUTES, CHECKOUT_RELEASE_AFTER_MS } from '@/lib/checkout-hold';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway, paid, state, unknown } from '../helpers/fake-gateway';

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

/* P0-04: la retención de un pedido sin pagar dura lo que la sesión de pago (CHECKOUT_HOLD_MINUTES) más un margen, y solo se libera con la
 * pasarela confirmando que ya no puede pagarse; el comprador que vuelve atrás desde la pasarela libera su pedido al instante. */

const MIN = 60_000;
const HOURS = 60 * MIN;
const run = async () => (await cron(new Request('http://localhost/api/cron/reconcile-payments', { headers: { Authorization: 'Bearer test-cron-secret' } }))).json();

describe('retención y abandono (P0-04)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const productIds: string[] = [];
  let n = 0;
  const pid = () => `cs_hold_${Date.now()}_${n++}`;

  beforeAll(async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    event = await createTestEvent();
    tt = await createTicketType(event.id, { maxQuantity: 50 });
  });
  afterAll(async () => {
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
  });
  beforeEach(async () => {
    gateway.reset();
    gateway.active = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.ticketType.update({ where: { id: tt.id }, data: { soldCount: 0 } });
  });
  afterEach(() => vi.restoreAllMocks());

  async function pending(ageMs: number, over: { paymentId?: string | null; provider?: string | null } = {}) {
    const paymentId = over.paymentId === undefined ? pid() : over.paymentId;
    const o = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Ret', buyerLastName: 'Ención', buyerEmail: `ret-${Math.random()}@example.com`, totalAmount: 10,
        paymentProvider: over.provider === undefined ? 'fake' : over.provider, paymentId, status: 'PENDING', createdAt: new Date(Date.now() - ageMs),
        tickets: { create: { eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-H-${Math.random()}`, holderName: 'Ret', status: 'PENDING' } },
      },
    });
    await prisma.ticketType.update({ where: { id: tt.id }, data: { soldCount: { increment: 1 } } });
    return o;
  }
  const reload = (id: string) => prisma.order.findUnique({ where: { id } });
  const sold = async () => (await prisma.ticketType.findUnique({ where: { id: tt.id } }))!.soldCount;

  describe('el cron: liberación a CHECKOUT_HOLD_MINUTES + 10 min, solo con resultado definitivo', () => {
    it('la retención es de 30 min y el cron libera a partir de 40', () => {
      expect(CHECKOUT_HOLD_MINUTES).toBe(30);
      expect(CHECKOUT_RELEASE_AFTER_MS).toBe(40 * MIN);
    });

    it('a los 35 min (sesión caducada pero dentro del margen) un PENDING abierto NO se libera ni se toca la sesión', async () => {
      const o = await pending(35 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'));
      const body = await run();
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(body).toMatchObject({ stillPending: 1, released: 0 });
      expect(gateway.count('cancel')).toBe(0);
    });

    it('a los 41 min, PENDING abierto: se cierra la sesión, se vuelve a verificar y se libera el aforo (patrón expirar → re-verificar → liberar)', async () => {
      const o = await pending(41 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'), state(o.paymentId!, 'EXPIRED'));
      const body = await run();
      expect((await reload(o.id))?.status).toBe('CANCELLED');
      expect(await sold()).toBe(0);
      expect(body.released).toBe(1);
      expect(gateway.calls.map((c) => c.op)).toEqual(['verify', 'cancel', 'verify']);
    });

    it('a los 41 min, la pasarela confirma el cierre aunque aún diga PENDING: se libera (ok del cierre = ya no se puede pagar)', async () => {
      const o = await pending(41 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'));
      expect((await run()).released).toBe(1);
      expect((await reload(o.id))?.status).toBe('CANCELLED');
    });

    it('a los 41 min, si la sesión NO se pudo cerrar y sigue abierta: no se libera (podría pagarse todavía)', async () => {
      const o = await pending(41 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'));
      gateway.cancelResults.set(o.paymentId!, { ok: false, error: 'timeout' });
      const body = await run();
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(await sold()).toBe(1);
      expect(body).toMatchObject({ released: 0, stillPending: 1 });
    });

    it('a los 41 min, FAILED (un intento rechazado, aún reintentable) se cierra y se libera; antes del plazo NO', async () => {
      const early = await pending(20 * MIN);
      const late = await pending(41 * MIN);
      gateway.script(early.paymentId!, state(early.paymentId!, 'FAILED'));
      gateway.script(late.paymentId!, state(late.paymentId!, 'FAILED'));
      await run();
      expect((await reload(early.id))?.status).toBe('PENDING');
      expect((await reload(late.id))?.status).toBe('CANCELLED');
    });

    it.each([
      ['UNKNOWN (la pasarela no se puede consultar)', (id: string) => unknown(id)],
      ['PROCESSING (cobro asíncrono en curso)', (id: string) => state(id, 'PROCESSING')],
    ])('a los 41 min con %s: NO se libera y no se cierra la sesión', async (_n, mk) => {
      const o = await pending(41 * MIN);
      gateway.script(o.paymentId!, mk(o.paymentId!));
      await run();
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(await sold()).toBe(1);
      expect(gateway.count('cancel')).toBe(0);
    });

    it('a los 41 min, si al cerrar resulta que YA ESTABA PAGADA: se completa', async () => {
      const o = await pending(41 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'), paid(o.paymentId!, 10));
      gateway.cancelResults.set(o.paymentId!, { ok: false, error: 'already complete' });
      await run();
      expect((await reload(o.id))?.status).toBe('COMPLETED');
    });

    it('un proveedor que no sabe cerrar la sesión no libera a los 41 min: solo la red de seguridad de 24 h', async () => {
      gateway.cancelCheckout = false;
      const young = await pending(41 * MIN);
      const old = await pending(25 * HOURS);
      gateway.script(young.paymentId!, state(young.paymentId!, 'PENDING'));
      gateway.script(old.paymentId!, state(old.paymentId!, 'PENDING'));
      await run();
      expect((await reload(young.id))?.status).toBe('PENDING');
      expect((await reload(old.id))?.status).toBe('CANCELLED');
    });

    it('las 24 h son solo la red de seguridad para pedidos SIN paymentId (nunca llegaron a la pasarela): a las 23 h se respetan, a las 25 h se liberan', async () => {
      const recent = await pending(23 * HOURS, { paymentId: null });
      const stale = await pending(25 * HOURS, { paymentId: null });
      const body = await run();
      expect((await reload(recent.id))?.status).toBe('PENDING');
      expect((await reload(stale.id))?.status).toBe('CANCELLED');
      expect(body.released).toBe(1);
      expect(gateway.calls).toHaveLength(0); // sin paymentId no hay a quién preguntar
    });

    it('un pedido con paymentId de hace 3 días sin poder verificarse NO cae en la red de seguridad: sigue PENDING y cuenta como error', async () => {
      const o = await pending(72 * HOURS);
      gateway.script(o.paymentId!, unknown(o.paymentId!, 'clave caducada'));
      const body = await run();
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(body).toMatchObject({ unknown: 1, errors: 1, released: 0 });
      expect(body.oldestPendingMinutes).toBeGreaterThanOrEqual(72 * 60);
    });

    it('cola justa: tras examinar un pedido, los nunca examinados pasan por delante (el sellado sigue funcionando con la nueva lógica)', async () => {
      const a = await pending(50 * MIN);
      gateway.script(a.paymentId!, unknown(a.paymentId!));
      await run();
      expect((await prisma.order.findUnique({ where: { id: a.id } }))!.reconcileAttempts).toBe(1);
      const b = await pending(10 * MIN);
      gateway.script(b.paymentId!, state(b.paymentId!, 'PENDING'));
      await run();
      expect((await prisma.order.findUnique({ where: { id: b.id } }))!.reconcileAttempts).toBe(1);
    });
  });

  describe('abandono por el comprador (cancelUrl): GET /api/orders/[orderId]/abandon', () => {
    const call = (id: string, token: string | null, ip = '203.0.113.9') =>
      abandonOrder(new Request(`http://localhost/api/orders/${id}/abandon${token ? `?t=${encodeURIComponent(token)}` : ''}`, { headers: { 'x-forwarded-for': ip } }), { params: Promise.resolve({ orderId: id }) });

    it('pendiente y la pasarela confirma que no hay pago: cierra la sesión, libera el aforo y redirige a la compra', async () => {
      const o = await pending(5 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'), state(o.paymentId!, 'EXPIRED'));
      const res = await call(o.id, signOrderAccess(o.id));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain(`/eventos/${event.slug}/comprar`);
      expect((await reload(o.id))?.status).toBe('CANCELLED');
      expect(await sold()).toBe(0);
      expect(gateway.count('cancel')).toBe(1);
    });

    it('ya pagado: no toca nada, lo completa y redirige a la confirmación', async () => {
      const o = await pending(5 * MIN);
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      const res = await call(o.id, signOrderAccess(o.id));
      expect(res.headers.get('location')).toContain(`/confirmacion/${o.id}`);
      expect((await reload(o.id))?.status).toBe('COMPLETED');
      expect(await sold()).toBe(1);
      expect(gateway.count('cancel')).toBe(0);
    });

    it('pedido ya COMPLETED: intacto y sin llamar a la pasarela', async () => {
      const o = await pending(5 * MIN);
      await prisma.order.update({ where: { id: o.id }, data: { status: 'COMPLETED' } });
      const res = await call(o.id, signOrderAccess(o.id));
      expect(res.headers.get('location')).toContain('/confirmacion/');
      expect((await reload(o.id))?.status).toBe('COMPLETED');
      expect(gateway.calls).toHaveLength(0);
    });

    it('verificación UNKNOWN: no libera (nunca con UNKNOWN) y manda a la confirmación, que lo comprobará', async () => {
      const o = await pending(5 * MIN);
      gateway.script(o.paymentId!, unknown(o.paymentId!));
      const res = await call(o.id, signOrderAccess(o.id));
      expect(res.headers.get('location')).toContain('/confirmacion/');
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(await sold()).toBe(1);
      expect(gateway.count('cancel')).toBe(0);
    });

    it('cobro en curso (PROCESSING): no libera', async () => {
      const o = await pending(5 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PROCESSING'));
      await call(o.id, signOrderAccess(o.id));
      expect((await reload(o.id))?.status).toBe('PENDING');
    });

    it('si no se puede cerrar la sesión y sigue abierta: no libera', async () => {
      const o = await pending(5 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'));
      gateway.cancelResults.set(o.paymentId!, { ok: false, error: 'timeout' });
      await call(o.id, signOrderAccess(o.id));
      expect((await reload(o.id))?.status).toBe('PENDING');
    });

    it('token inválido, ausente o de OTRO pedido: 401 y no se toca nada', async () => {
      const a = await pending(5 * MIN);
      const b = await pending(5 * MIN);
      for (const token of [null, 'basura', signOrderAccess(b.id), signShopOrderAccess(a.id)]) {
        expect((await call(a.id, token)).status).toBe(401);
      }
      expect((await reload(a.id))?.status).toBe('PENDING');
      expect(gateway.calls).toHaveLength(0);
    });

    it('un HEAD (rastreador, precarga de enlaces) responde 405 y no libera nada', async () => {
      const o = await pending(5 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'), state(o.paymentId!, 'EXPIRED'));
      expect(headOrder().status).toBe(405);
      expect(headShopOrder().status).toBe(405);
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(gateway.calls).toHaveLength(0);
    });

    it('pedido inexistente con un token válido para ese id: 404', async () => {
      expect((await call('no-existe', signOrderAccess('no-existe'))).status).toBe(404);
    });

    it('limita los intentos por pedido e IP (cada uno consulta la pasarela)', async () => {
      const o = await pending(5 * MIN);
      gateway.script(o.paymentId!, state(o.paymentId!, 'PROCESSING'));
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await call(o.id, signOrderAccess(o.id), '203.0.113.77')).status);
      expect(statuses.slice(0, 6).every((s) => s === 303)).toBe(true);
      expect(statuses.slice(6)).toEqual([429, 429]);
    });

    it('un pedido sin paymentId (nunca llegó a la pasarela) no se libera por esta vía', async () => {
      const o = await pending(5 * MIN, { paymentId: null });
      await call(o.id, signOrderAccess(o.id));
      expect((await reload(o.id))?.status).toBe('PENDING');
    });
  });

  describe('abandono en la tienda: GET /api/shop/orders/[orderId]/abandon', () => {
    async function shopPending(stock = 4) {
      const product = await prisma.product.create({ data: { name: 'Ab', slug: `ab-${Date.now()}-${n++}`, price: 10, variants: { create: { size: 'M', color: '', stock } } } });
      productIds.push(product.id);
      const o = await prisma.shopOrder.create({
        data: { buyerName: 'A', buyerEmail: 'ab@example.com', shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 10, paymentProvider: 'fake', paymentId: pid(), status: 'PENDING', items: { create: { productId: product.id, quantity: 1, unitPrice: 10, size: 'M', color: '' } } },
      });
      await prisma.productVariant.updateMany({ where: { productId: product.id }, data: { stock: stock - 1 } });
      return { o, productId: product.id };
    }
    const callShop = (id: string, token: string | null) =>
      abandonShopOrder(new Request(`http://localhost/api/shop/orders/${id}/abandon${token ? `?t=${encodeURIComponent(token)}` : ''}`, { headers: { 'x-forwarded-for': '203.0.113.50' } }), { params: Promise.resolve({ orderId: id }) });
    const stock = async (productId: string) => (await prisma.productVariant.findFirst({ where: { productId } }))!.stock;

    it('pendiente sin pago: se libera el stock y se vuelve al checkout (el carrito sigue en el navegador)', async () => {
      const { o, productId } = await shopPending();
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'), state(o.paymentId!, 'EXPIRED'));
      const res = await callShop(o.id, signShopOrderAccess(o.id));
      expect(res.headers.get('location')).toContain('/tienda/checkout');
      expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('CANCELLED');
      expect(await stock(productId)).toBe(4);
    });

    it('pagado: intacto y a la confirmación', async () => {
      const { o, productId } = await shopPending();
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      const res = await callShop(o.id, signShopOrderAccess(o.id));
      expect(res.headers.get('location')).toContain(`/tienda/confirmacion/${o.id}`);
      expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('PAID');
      expect(await stock(productId)).toBe(3);
    });

    it('UNKNOWN: intacto; token inválido (también el de un pedido de entradas): 401', async () => {
      const { o, productId } = await shopPending();
      gateway.script(o.paymentId!, unknown(o.paymentId!));
      await callShop(o.id, signShopOrderAccess(o.id));
      expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('PENDING');
      expect(await stock(productId)).toBe(3);
      expect((await callShop(o.id, signOrderAccess(o.id))).status).toBe(401);
      expect((await callShop(o.id, null)).status).toBe(401);
    });
  });

  it('el cron libera también pedidos de TIENDA a los 41 min con la pasarela confirmando; con UNKNOWN no', async () => {
    const mk = async (stock: number) => {
      const product = await prisma.product.create({ data: { name: 'Cr', slug: `cr-${Date.now()}-${n++}`, price: 10, variants: { create: { size: 'M', color: '', stock: stock - 1 } } } });
      productIds.push(product.id);
      const o = await prisma.shopOrder.create({
        data: { buyerName: 'C', buyerEmail: 'cr@example.com', shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 10, paymentProvider: 'fake', paymentId: pid(), status: 'PENDING', createdAt: new Date(Date.now() - 41 * MIN), items: { create: { productId: product.id, quantity: 1, unitPrice: 10, size: 'M', color: '' } } },
      });
      return { o, productId: product.id };
    };
    const ok = await mk(3);
    const ko = await mk(3);
    gateway.script(ok.o.paymentId!, state(ok.o.paymentId!, 'PENDING'), state(ok.o.paymentId!, 'EXPIRED'));
    gateway.script(ko.o.paymentId!, unknown(ko.o.paymentId!));
    await run();
    expect((await prisma.shopOrder.findUnique({ where: { id: ok.o.id } }))?.status).toBe('CANCELLED');
    expect((await prisma.productVariant.findFirst({ where: { productId: ok.productId } }))?.stock).toBe(3);
    expect((await prisma.shopOrder.findUnique({ where: { id: ko.o.id } }))?.status).toBe('PENDING');
    expect((await prisma.productVariant.findFirst({ where: { productId: ko.productId } }))?.stock).toBe(2);
  });
});
