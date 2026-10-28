import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { POST as createShopOrder } from '@/app/api/shop/orders/route';
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';

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

/* P1-07: importes. El total se calcula en céntimos y es el MISMO en la BD y en la pasarela; una entrada de 0 € se vende sin pasarela; un importe por
 * debajo del mínimo de Stripe se rechaza con un mensaje claro; y el webhook de Stripe contrasta el importe cobrado antes de completar el pedido. */

const runId = Math.floor(Math.random() * 60_000);
let ipCounter = 0;
const freshIp = () => `10.${runId >> 8}.${runId & 255}.${(ipCounter += 1)}`;
const post = (body: unknown) =>
  createOrder(new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ acceptedTerms: true, ...(body as object) }) }));

describe('importes de venta (P1-07)', () => {
  let origCommission: string | null;
  let origCap: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    origCommission = await getAndSetConfig('commission_percentage', '0');
    origCap = await getAndSetConfig('orders_max_pending_per_ip', '1000');
    event = await createTestEvent({ maxCapacity: 500 });
  });
  afterAll(async () => {
    await restoreConfig('commission_percentage', origCommission);
    await restoreConfig('orders_max_pending_per_ip', origCap);
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'pending:' } } });
  });
  beforeEach(async () => {
    gateway.reset();
    gateway.active = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'pending:' } } });
    await getAndSetConfig('commission_percentage', '0');
  });
  afterEach(() => vi.restoreAllMocks());

  const body = (ticketTypeId: string, quantity: number) => ({
    eventId: event.id, buyerName: 'Ana', buyerLastName: 'López', buyerEmail: `ana-${Math.random()}@example.com`, items: [{ ticketTypeId, quantity }],
  });
  const orders = () => prisma.order.findMany({ where: { eventId: event.id }, include: { tickets: true } });

  it('con comisión del 1,5 %, el total de la BD es EXACTAMENTE el importe que se pide a la pasarela (caso del informe: 2 × 16,50 €)', async () => {
    await getAndSetConfig('commission_percentage', '1.5');
    const tt = await createTicketType(event.id, { price: 16.5, maxQuantity: 100 });
    const res = await post(body(tt.id, 2));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.totalAmount).toBe(33.5);
    const [order] = await orders();
    expect(Number(order.totalAmount)).toBe(33.5);
    expect(Number(order.commission)).toBe(0.5);
    expect(gateway.sessions).toHaveLength(1);
    expect(gateway.sessions[0].amount).toBe(33.5);
    expect(Math.round(gateway.sessions[0].amount * 100)).toBe(3350); // lo que cobraría Stripe, sin 33,49
  });

  describe('entradas gratuitas (0 €)', () => {
    it('con pasarela real se venden SIN pasarela: pedido completado, entradas válidas, ninguna sesión de pago', async () => {
      const tt = await createTicketType(event.id, { price: 0, maxQuantity: 100 });
      const res = await post(body(tt.id, 2));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.checkoutUrl).toBeNull();
      expect(json.totalAmount).toBe(0);
      expect(gateway.sessions).toHaveLength(0);
      const [order] = await orders();
      expect(order.status).toBe('COMPLETED');
      expect(order.paymentMethod).toBe('FREE');
      expect(order.paymentId).toBeNull();
      expect(order.tickets.map((t) => t.status)).toEqual(['VALID', 'VALID']);
      expect((await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).soldCount).toBe(2);
    });

    it('un pedido gratuito no ocupa hueco del cupo de pedidos pendientes por IP', async () => {
      const tt = await createTicketType(event.id, { price: 0, maxQuantity: 100 });
      await post(body(tt.id, 1));
      expect(await prisma.rateLimitBucket.count({ where: { key: { startsWith: 'pending:orders' } } })).toBe(0);
    });

    it('mezclar una entrada gratuita con una de pago SÍ cobra el total (el de pago)', async () => {
      const free = await createTicketType(event.id, { price: 0, maxQuantity: 100 });
      const paidType = await createTicketType(event.id, { price: 10, maxQuantity: 100 });
      const res = await createOrder(new Request('http://localhost/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': freshIp() },
        body: JSON.stringify({ acceptedTerms: true, eventId: event.id, buyerName: 'Ana', buyerLastName: 'López', buyerEmail: 'mix@example.com', items: [{ ticketTypeId: free.id, quantity: 1 }, { ticketTypeId: paidType.id, quantity: 1 }] }),
      }));
      expect(res.status).toBe(200);
      expect(gateway.sessions).toHaveLength(1);
      expect(gateway.sessions[0].amount).toBe(10);
      expect((await orders())[0].status).toBe('PENDING');
    });
  });

  describe('importe mínimo de pago online (0,50 €)', () => {
    it('un total entre 0,01 € y 0,49 € se rechaza con un mensaje claro y no deja nada reservado', async () => {
      const tt = await createTicketType(event.id, { price: 0.3, maxQuantity: 100 });
      const res = await post(body(tt.id, 1));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/mínimo.*0,50/i);
      expect(await orders()).toHaveLength(0);
      expect((await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).soldCount).toBe(0);
      expect(gateway.sessions).toHaveLength(0);
    });

    it('exactamente 0,50 € se acepta', async () => {
      const tt = await createTicketType(event.id, { price: 0.5, maxQuantity: 100 });
      expect((await post(body(tt.id, 1))).status).toBe(200);
      expect(gateway.sessions[0].amount).toBe(0.5);
    });
  });
});

describe('webhook de Stripe: contraste del importe cobrado (P1-07)', () => {
  const SECRET_KEY = 'sk_test_fake_for_signature_only';
  const WEBHOOK_SECRET = 'whsec_test_secret_for_vitest_amounts';
  let origKey: string | null;
  let origWebhook: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const eventIds: string[] = [];

  beforeAll(async () => {
    origKey = await getAndSetConfig('stripe_secret_key', SECRET_KEY);
    origWebhook = await getAndSetConfig('stripe_webhook_secret', WEBHOOK_SECRET);
    event = await createTestEvent();
    tt = await createTicketType(event.id, { maxQuantity: 50 });
    // Ids fijos: si una ejecución anterior murió a medias, quedarían como «ya procesados» y este archivo fallaría en falso.
    await prisma.processedWebhookEvent.deleteMany({ where: { id: { startsWith: 'evt_amt_' } } });
  });
  afterAll(async () => {
    await restoreConfig('stripe_secret_key', origKey);
    await restoreConfig('stripe_webhook_secret', origWebhook);
    await prisma.processedWebhookEvent.deleteMany({ where: { id: { in: eventIds } } });
    await cleanupTestEvent(event.id);
  });
  beforeEach(() => {
    gateway.reset(); // el bloque anterior la dejó activa: aquí el webhook habla con Stripe «de verdad» (firma), no con la pasarela falsa
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  async function pendingOrder(total: number, paymentId: string) {
    return prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Wh', buyerLastName: 'Amount', buyerEmail: 'wh-amount@example.com', totalAmount: total, paymentProvider: 'stripe', paymentId, status: 'PENDING',
        tickets: { create: { eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-AMT-${Date.now()}-${Math.random()}`, holderName: 'Wh Amount', status: 'PENDING' } },
      },
    });
  }
  async function send(orderId: string, amountTotal: number | undefined, evtId: string, currency = 'eur') {
    eventIds.push(evtId);
    const payload = JSON.stringify({
      id: evtId, type: 'checkout.session.completed',
      data: { object: { id: `cs_${evtId}`, payment_status: 'paid', metadata: { orderId }, ...(amountTotal !== undefined ? { amount_total: amountTotal, currency } : {}) } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `t=${ts},v1=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex')}`;
    return stripeWebhook(new Request('http://localhost/api/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body: payload }));
  }
  const statusOf = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).status;

  it('un cobro de 1 € sobre un pedido de 10 € NO completa el pedido (antes el webhook lo daba por bueno)', async () => {
    const order = await pendingOrder(10, 'cs_amt_low');
    expect((await send(order.id, 100, 'evt_amt_low')).status).toBe(200);
    expect(await statusOf(order.id)).toBe('PENDING');
  });

  it('el importe exacto completa el pedido', async () => {
    const order = await pendingOrder(33.5, 'cs_amt_ok');
    await send(order.id, 3350, 'evt_amt_ok');
    expect(await statusOf(order.id)).toBe('COMPLETED');
  });

  it('un céntimo de diferencia se tolera (redondeos antiguos): se completa', async () => {
    const order = await pendingOrder(33.5, 'cs_amt_cent');
    await send(order.id, 3349, 'evt_amt_cent');
    expect(await statusOf(order.id)).toBe('COMPLETED');
  });

  it('dos céntimos de diferencia ya no cuadran', async () => {
    const order = await pendingOrder(33.5, 'cs_amt_two');
    await send(order.id, 3348, 'evt_amt_two');
    expect(await statusOf(order.id)).toBe('PENDING');
  });

  it('una moneda distinta a EUR no cuadra aunque el número coincida', async () => {
    const order = await pendingOrder(10, 'cs_amt_usd');
    await send(order.id, 1000, 'evt_amt_usd', 'usd');
    expect(await statusOf(order.id)).toBe('PENDING');
  });

  it('sin importe en el evento se mantiene el comportamiento de siempre (se completa)', async () => {
    const order = await pendingOrder(10, 'cs_amt_none');
    await send(order.id, undefined, 'evt_amt_none');
    expect(await statusOf(order.id)).toBe('COMPLETED');
  });
});

describe('tienda: importes en céntimos y mínimo de pago (P1-07)', () => {
  const productIds: string[] = [];
  beforeEach(() => {
    gateway.reset();
    gateway.active = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'pending:' } } });
  });

  const shop = async (price: number, quantity: number) => {
    const p = await prisma.product.create({ data: { name: 'Importe', slug: `importe-${Date.now()}-${Math.random()}`, price, variants: { create: { size: 'M', color: '', stock: 100 } } } });
    productIds.push(p.id);
    return createShopOrder(new Request('http://localhost/api/shop/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ acceptedTerms: true, buyerName: 'Luis', buyerEmail: `luis-${Math.random()}@example.com`, shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001', items: [{ productId: p.id, quantity, size: 'M' }] }),
    }));
  };

  it('3 × 19,99 € son 59,97 € exactos en la BD y en la sesión de pago (sin 59,96999…)', async () => {
    const res = await shop(19.99, 3);
    expect(res.status).toBe(200);
    expect(gateway.sessions).toHaveLength(1);
    expect(gateway.sessions[0].amount).toBe(59.97);
    const { orderId } = await res.json();
    expect(Number((await prisma.shopOrder.findUniqueOrThrow({ where: { id: orderId } })).totalAmount)).toBe(59.97);
  });

  it('un pedido de menos de 0,50 € se rechaza con un mensaje claro y no reserva stock', async () => {
    const res = await shop(0.3, 1);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/mínimo.*0,50/i);
    expect(gateway.sessions).toHaveLength(0);
    const pid = productIds[productIds.length - 1];
    expect((await prisma.productVariant.findFirstOrThrow({ where: { productId: pid } })).stock).toBe(100);
  });
});
