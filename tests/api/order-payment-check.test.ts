import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as getOrder } from '@/app/api/orders/[orderId]/route';
import { GET as getShopOrder } from '@/app/api/shop/orders/[orderId]/route';
import { signOrderAccess, signShopOrderAccess } from '@/lib/access-token';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway, paid, state, unknown } from '../helpers/fake-gateway';

vi.mock('@/lib/mailer', async (orig) => ({ ...(await orig<typeof import('@/lib/mailer')>()), sendMail: async () => ({ success: true, transport: 'smtp' as const }) }));
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return { ...actual, getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)) };
});

/* M6: el GET del pedido devuelve el resultado EXPLÍCITO de comprobar un pedido anulado con pago (`paymentCheck`), lo cachea unos segundos y limita
 * las consultas a la pasarela por pedido e IP. */

describe('GET del pedido: paymentCheck', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const productIds: string[] = [];
  let n = 0;
  const pid = () => `cs_pc_${Date.now()}_${n++}`;

  beforeAll(async () => {
    event = await createTestEvent({ maxCapacity: 100 });
    tt = await createTicketType(event.id, { maxQuantity: 100 });
  });
  afterAll(async () => {
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'paycheck:' } } });
  });
  beforeEach(async () => {
    gateway.reset();
    gateway.active = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.ticketType.update({ where: { id: tt.id }, data: { soldCount: 0 } });
  });
  afterEach(() => vi.restoreAllMocks());

  async function mk(status: 'PENDING' | 'CANCELLED' | 'COMPLETED', over: { paymentId?: string | null; ageMs?: number } = {}) {
    const paymentId = over.paymentId === undefined ? pid() : over.paymentId;
    return prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Pc', buyerLastName: 'Check', buyerEmail: `pc-${Math.random()}@example.com`, totalAmount: 10, paymentProvider: 'fake', paymentId, status,
        createdAt: new Date(Date.now() - (over.ageMs ?? 3 * 60 * 60_000)),
        tickets: { create: { eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-PC-${Math.random()}`, holderName: 'Pc', status: status === 'COMPLETED' ? 'VALID' : status === 'PENDING' ? 'PENDING' : 'CANCELLED' } },
      },
    });
  }
  const get = async (id: string, ip = '203.0.113.5') => {
    const res = await getOrder(new Request(`http://localhost/api/orders/${id}?t=${encodeURIComponent(signOrderAccess(id))}`, { headers: { 'x-forwarded-for': ip } }), { params: Promise.resolve({ orderId: id }) });
    return res.json();
  };
  const clearCache = () => prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'paycheck:' } } });

  it('la pasarela confirma que NO se pagó (EXPIRED) → paymentCheck "not_paid"', async () => {
    const o = await mk('CANCELLED');
    gateway.script(o.paymentId!, state(o.paymentId!, 'EXPIRED'));
    const body = await get(o.id);
    expect(body).toMatchObject({ status: 'CANCELLED', paymentCheck: 'not_paid' });
  });

  it.each([
    ['UNKNOWN (la pasarela no responde)', (id: string) => unknown(id)],
    ['PROCESSING (cobro en curso)', (id: string) => state(id, 'PROCESSING')],
  ])('%s → "checking"', async (_n, mkResult) => {
    const o = await mk('CANCELLED');
    gateway.script(o.paymentId!, mkResult(o.paymentId!));
    expect((await get(o.id)).paymentCheck).toBe('checking');
  });

  it('pagado después de liberarse → "paid", y el pedido ya viene reactivado (COMPLETED) en la misma respuesta', async () => {
    const o = await mk('CANCELLED');
    gateway.script(o.paymentId!, paid(o.paymentId!, 10));
    const body = await get(o.id);
    expect(body).toMatchObject({ status: 'COMPLETED', paymentCheck: 'paid' });
  });

  it('cobro reembolsado en la pasarela → "refunded"', async () => {
    const o = await mk('CANCELLED');
    gateway.refunded.add(o.paymentId!);
    expect((await get(o.id)).paymentCheck).toBe('refunded');
  });

  it('sin pago asociado, o con otro estado (PENDING, COMPLETED), o muy antiguo: "none" y sin llamar a la pasarela', async () => {
    const noPay = await mk('CANCELLED', { paymentId: null });
    const pending = await mk('PENDING');
    const done = await mk('COMPLETED');
    const old = await mk('CANCELLED', { ageMs: 8 * 24 * 60 * 60_000 });
    gateway.script(pending.paymentId!, state(pending.paymentId!, 'PENDING'));
    for (const o of [noPay, pending, done, old]) expect((await get(o.id)).paymentCheck, o.id).toBe('none');
    expect(gateway.calls.filter((c) => c.paymentId === noPay.paymentId || c.paymentId === done.paymentId || c.paymentId === old.paymentId)).toHaveLength(0);
  });

  it('CACHÉ: los sondeos seguidos del mismo pedido no vuelven a consultar la pasarela (6 GET → 1 verificación), y caducada la caché sí', async () => {
    const o = await mk('CANCELLED');
    gateway.script(o.paymentId!, state(o.paymentId!, 'EXPIRED'));
    for (let i = 0; i < 6; i++) expect((await get(o.id)).paymentCheck).toBe('not_paid');
    expect(gateway.count('verify', o.paymentId!)).toBe(1);
    await prisma.rateLimitBucket.updateMany({ where: { key: { startsWith: `paycheck:${o.id}:` } }, data: { resetAt: new Date(Date.now() - 1000) } });
    await get(o.id);
    expect(gateway.count('verify', o.paymentId!)).toBe(2);
  });

  it('LÍMITE por pedido e IP: pasadas 12 consultas en un minuto no se llama más a la pasarela y se responde "checking" (nunca un 429)', async () => {
    const o = await mk('CANCELLED');
    gateway.script(o.paymentId!, state(o.paymentId!, 'EXPIRED'));
    for (let i = 0; i < 12; i++) {
      await get(o.id, '203.0.113.99');
      await clearCache(); // sin caché: cada una cuenta como consulta real
    }
    expect(gateway.count('verify', o.paymentId!)).toBe(12);
    const body = await get(o.id, '203.0.113.99');
    expect(body.paymentCheck).toBe('checking');
    expect(gateway.count('verify', o.paymentId!)).toBe(12);
    // Otra IP tiene su propio contador.
    expect((await get(o.id, '203.0.113.100')).paymentCheck).toBe('not_paid');
  });

  describe('tienda', () => {
    async function shopCancelled(stock = 5) {
      const p = await prisma.product.create({ data: { name: 'Pc', slug: `pc-${Date.now()}-${n++}`, price: 10, variants: { create: { size: 'M', color: '', stock } } } });
      productIds.push(p.id);
      return prisma.shopOrder.create({ data: { buyerName: 'P', buyerEmail: 'pc-shop@example.com', shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 10, paymentProvider: 'fake', paymentId: pid(), status: 'CANCELLED', items: { create: { productId: p.id, quantity: 1, unitPrice: 10, size: 'M', color: '' } } } });
    }
    const getShop = async (id: string) => (await getShopOrder(new Request(`http://localhost/api/shop/orders/${id}?t=${encodeURIComponent(signShopOrderAccess(id))}`, { headers: { 'x-forwarded-for': '203.0.113.6' } }), { params: Promise.resolve({ orderId: id }) })).json();

    it('not_paid, checking, paid (reanimado) y refunded', async () => {
      const a = await shopCancelled();
      gateway.script(a.paymentId!, state(a.paymentId!, 'EXPIRED'));
      expect((await getShop(a.id)).paymentCheck).toBe('not_paid');

      const b = await shopCancelled();
      gateway.script(b.paymentId!, unknown(b.paymentId!));
      expect((await getShop(b.id)).paymentCheck).toBe('checking');

      const c = await shopCancelled();
      gateway.script(c.paymentId!, paid(c.paymentId!, 10));
      expect(await getShop(c.id)).toMatchObject({ status: 'PAID', paymentCheck: 'paid' });

      const d = await shopCancelled();
      gateway.refunded.add(d.paymentId!);
      expect((await getShop(d.id)).paymentCheck).toBe('refunded');
    });

    it('caché: varios sondeos, una sola verificación', async () => {
      const a = await shopCancelled();
      gateway.script(a.paymentId!, state(a.paymentId!, 'EXPIRED'));
      for (let i = 0; i < 5; i++) await getShop(a.id);
      expect(gateway.count('verify', a.paymentId!)).toBe(1);
    });
  });
});
