import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { StripeAdapter } from '@/lib/payment-adapter';
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route';
import { alertDisputeOpened, applyGatewayRefund, repairRefundedOrders, sendRefundEmail } from '@/lib/reconciliation/gateway-refund';
import { invalidateOrder } from '@/lib/reconciliation/entradas';
import { refundIdempotencyKey, REFUND_KEY_WINDOW_MS } from '@/lib/reconciliation/shared';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; html: string }[], fail: false }));
vi.mock('@/lib/mailer', async (orig) => ({
  ...(await orig<typeof import('@/lib/mailer')>()),
  sendMail: async (p: { to: string; subject: string; html: string }) => {
    if (mail.fail) return { success: false, error: 'smtp caído', transport: 'smtp' as const };
    mail.sent.push(p);
    return { success: true, transport: 'smtp' as const };
  },
}));
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return { ...actual, getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)) };
});

/* P1-01 / EN-08 / CO-02 / TI-08 / TI-09: dinero devuelto FUERA de la app (reembolso en el panel de Stripe, contracargo), pedidos REFUNDED con entradas
 * activas, clave de idempotencia del reembolso y aviso al comprador. BD real; Stripe solo para firmar webhooks (sin red). */

const TEST_SECRET_KEY = 'sk_test_fake_for_signature_only';
const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_vitest_refunds';
const suffix = `${Date.now()}`;
const buyerMails = (to: string) => mail.sent.filter((m) => m.to === to);

function sign(payload: string) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', TEST_WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')}`;
}
const post = (payload: string) =>
  stripeWebhook(new Request('http://localhost/api/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sign(payload) }, body: payload }));

let evCounter = 0;
const evId = () => `evt_gr_${suffix}_${evCounter++}`;
const chargeEvent = (orderId: string | null, over: { amount?: number; refunded?: number; id?: string } = {}) => {
  const amount = over.amount ?? 1000;
  const refunded = over.refunded ?? amount;
  return JSON.stringify({
    id: over.id ?? evId(), object: 'event', type: 'charge.refunded',
    data: { object: { id: 'ch_x', object: 'charge', amount, amount_refunded: refunded, refunded: refunded >= amount, payment_intent: 'pi_x', metadata: orderId ? { orderId } : {} } },
  });
};
const disputeEvent = (type: 'charge.dispute.created' | 'charge.dispute.closed', status: string, orderId: string) =>
  JSON.stringify({ id: evId(), object: 'event', type, data: { object: { id: 'dp_x', object: 'dispute', amount: 1000, status, reason: 'fraudulent', charge: 'ch_x', payment_intent: 'pi_x', metadata: { orderId } } } });

describe('reembolsos fuera de la app (P1-01)', () => {
  let originalSecretKey: string | null;
  let originalWebhookSecret: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const productIds: string[] = [];
  const orderIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    originalSecretKey = await getAndSetConfig('stripe_secret_key', TEST_SECRET_KEY);
    originalWebhookSecret = await getAndSetConfig('stripe_webhook_secret', TEST_WEBHOOK_SECRET);
    event = await createTestEvent();
    tt = await createTicketType(event.id, { maxQuantity: 100 });
  });
  afterAll(async () => {
    await restoreConfig('stripe_secret_key', originalSecretKey);
    await restoreConfig('stripe_webhook_secret', originalWebhookSecret);
    await prisma.processedWebhookEvent.deleteMany({ where: { OR: [{ id: { startsWith: `evt_gr_${suffix}` } }, { id: { in: orderIds.map((id) => `refund-mail:${id}`) } }] } });
    await prisma.shopOrder.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
  });
  beforeEach(() => {
    mail.sent = [];
    mail.fail = false;
    gateway.reset();
  });
  afterEach(() => vi.restoreAllMocks());

  /** Pedido de entradas con N entradas VALID (y opcionalmente una USED). `soldCount` del tipo sube en consecuencia. */
  async function makeOrder(o: { status?: 'COMPLETED' | 'PENDING' | 'REFUNDED'; valid?: number; used?: number; email?: string; provider?: string } = {}) {
    const valid = o.valid ?? 2;
    const used = o.used ?? 0;
    const email = o.email ?? `gr-${suffix}-${n++}@example.com`;
    const order = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Gr', buyerLastName: 'Test', buyerEmail: email, totalAmount: 10, status: o.status ?? 'COMPLETED',
        paymentMethod: 'CARD', paymentProvider: o.provider ?? 'stripe', paymentId: `cs_gr_${suffix}_${n}`,
        tickets: {
          create: [
            ...Array.from({ length: valid }, (_, i) => ({ eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-GR-${suffix}-${n}-v${i}`, holderName: 'Gr', status: 'VALID' as const })),
            ...Array.from({ length: used }, (_, i) => ({ eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-GR-${suffix}-${n}-u${i}`, holderName: 'Gr', status: 'USED' as const })),
          ],
        },
      },
    });
    orderIds.push(order.id);
    await prisma.ticketType.update({ where: { id: tt.id }, data: { soldCount: { increment: valid + used } } });
    return { order, email };
  }
  const sold = async () => (await prisma.ticketType.findUnique({ where: { id: tt.id } }))!.soldCount;
  const statusOf = async (id: string) => (await prisma.order.findUnique({ where: { id } }))!.status;
  const ticketStatuses = async (id: string) => (await prisma.ticket.findMany({ where: { orderId: id }, select: { status: true } })).map((t) => t.status).sort();

  describe('applyGatewayRefund: entradas', () => {
    it('un reembolso TOTAL anula el pedido y sus entradas VALID, libera el aforo, deja las ya usadas y avisa al comprador', async () => {
      const { order, email } = await makeOrder({ valid: 2, used: 1 });
      const before = await sold();
      expect(await applyGatewayRefund({ orderId: order.id, full: true, refunded: 10, total: 10, source: 'refund' })).toBe('applied');
      expect(await statusOf(order.id)).toBe('REFUNDED');
      expect(await ticketStatuses(order.id)).toEqual(['REFUNDED', 'REFUNDED', 'USED']);
      expect(await sold()).toBe(before - 2);
      const mails = buyerMails(email);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toMatch(/reembolso/i);
      expect(mails[0].html).toContain('10,00 €');
    });

    it('es idempotente: una segunda entrega del mismo reembolso no cambia nada ni vuelve a avisar', async () => {
      const { order, email } = await makeOrder();
      await applyGatewayRefund({ orderId: order.id, full: true, refunded: 10, total: 10, source: 'refund' });
      const afterFirst = await sold();
      expect(await applyGatewayRefund({ orderId: order.id, full: true, refunded: 10, total: 10, source: 'refund' })).toBe('already');
      expect(await sold()).toBe(afterFirst);
      expect(buyerMails(email)).toHaveLength(1);
    });

    it('dos entregas SIMULTÁNEAS anulan una sola vez (compare-and-swap): el aforo se libera una vez', async () => {
      const { order, email } = await makeOrder({ valid: 3 });
      const before = await sold();
      const r = await Promise.all([1, 2, 3].map(() => applyGatewayRefund({ orderId: order.id, full: true, refunded: 10, total: 10, source: 'refund' })));
      expect(r.filter((x) => x === 'applied')).toHaveLength(1);
      expect(await sold()).toBe(before - 3);
      expect(buyerMails(email)).toHaveLength(1);
    });

    it('un reembolso PARCIAL no cambia nada (no hay precio por entrada): solo avisa al operador', async () => {
      const { order, email } = await makeOrder();
      const before = await sold();
      expect(await applyGatewayRefund({ orderId: order.id, full: false, refunded: 4, total: 10, source: 'refund' })).toBe('partial_alerted');
      expect(await statusOf(order.id)).toBe('COMPLETED');
      expect(await ticketStatuses(order.id)).toEqual(['VALID', 'VALID']);
      expect(await sold()).toBe(before);
      expect(buyerMails(email)).toHaveLength(0);
    });

    it('un contracargo PERDIDO anula igual, pero no escribe al comprador', async () => {
      const { order, email } = await makeOrder();
      expect(await applyGatewayRefund({ orderId: order.id, full: true, refunded: 10, total: 10, source: 'dispute_lost' })).toBe('applied');
      expect(await statusOf(order.id)).toBe('REFUNDED');
      expect(buyerMails(email)).toHaveLength(0);
    });

    it('un pedido ya REFUNDED por la app (su propio webhook) no se toca', async () => {
      const { order } = await makeOrder({ status: 'REFUNDED', valid: 0 });
      expect(await applyGatewayRefund({ orderId: order.id, full: true, refunded: 10, total: 10, source: 'refund' })).toBe('already');
    });

    it('un reembolso sobre un pedido sin pagar no lo cambia: avisa', async () => {
      const { order } = await makeOrder({ status: 'PENDING' });
      expect(await applyGatewayRefund({ orderId: order.id, full: true, refunded: 10, total: 10, source: 'refund' })).toBe('inactive');
      expect(await statusOf(order.id)).toBe('PENDING');
    });

    it('un pedido que no existe en esta BD se devuelve como «missing»', async () => {
      expect(await applyGatewayRefund({ orderId: 'no-existe', full: true, refunded: 10, total: 10, source: 'refund' })).toBe('missing');
    });
  });

  describe('applyGatewayRefund: tienda', () => {
    async function shopOrder(status: 'PAID' | 'SHIPPED') {
      const p = await prisma.product.create({ data: { name: 'Gr', slug: `gr-${suffix}-${n++}`, price: 10, variants: { create: { size: 'M', color: '', stock: 5 } } } });
      productIds.push(p.id);
      const email = `gr-shop-${suffix}-${n}@example.com`;
      const o = await prisma.shopOrder.create({
        data: { buyerName: 'Gr', buyerEmail: email, shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 10, paymentProvider: 'stripe', paymentId: `cs_grs_${suffix}_${n}`, status, items: { create: { productId: p.id, quantity: 2, unitPrice: 5, size: 'M', color: '' } } },
      });
      orderIds.push(o.id);
      return { o, email, productId: p.id };
    }
    const stock = async (productId: string) => (await prisma.productVariant.findFirst({ where: { productId } }))!.stock;

    it('un reembolso total de un pedido PAGADO lo marca REFUNDED, repone el stock y avisa', async () => {
      const { o, email, productId } = await shopOrder('PAID');
      expect(await applyGatewayRefund({ orderId: o.id, full: true, refunded: 10, total: 10, source: 'refund' })).toBe('applied');
      expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('REFUNDED');
      expect(await stock(productId)).toBe(7);
      expect(buyerMails(email)).toHaveLength(1);
      expect(await applyGatewayRefund({ orderId: o.id, full: true, refunded: 10, total: 10, source: 'refund' })).toBe('already');
      expect(await stock(productId)).toBe(7); // no se repone dos veces
    });

    it('con la mercancía ya ENVIADA el dinero vuelve pero el stock no se repone', async () => {
      const { o, productId } = await shopOrder('SHIPPED');
      expect(await applyGatewayRefund({ orderId: o.id, full: true, refunded: 10, total: 10, source: 'refund' })).toBe('applied');
      expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('REFUNDED');
      expect(await stock(productId)).toBe(5);
    });

    it('un reembolso parcial en la tienda solo avisa', async () => {
      const { o } = await shopOrder('PAID');
      expect(await applyGatewayRefund({ orderId: o.id, full: false, refunded: 3, total: 10, source: 'refund' })).toBe('partial_alerted');
      expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('PAID');
    });
  });

  describe('disputas', () => {
    it('una disputa abierta solo avisa: no anula nada', async () => {
      const { order } = await makeOrder();
      expect(await alertDisputeOpened(order.id, 10, 'fraudulent')).toBe(true);
      expect(await statusOf(order.id)).toBe('COMPLETED');
      expect(await alertDisputeOpened('no-existe', 10)).toBe(false);
    });
  });

  describe('webhook de Stripe: charge.refunded y disputas', () => {
    it('un reembolso total hecho en el panel de Stripe anula el pedido; reenviar el mismo evento es un duplicado', async () => {
      const { order, email } = await makeOrder();
      const payload = chargeEvent(order.id);
      const res = await post(payload);
      expect(res.status).toBe(200);
      expect(await statusOf(order.id)).toBe('REFUNDED');
      expect(await ticketStatuses(order.id)).toEqual(['REFUNDED', 'REFUNDED']);
      expect((await post(payload).then((r) => r.json())).duplicate).toBe(true);
      expect(buyerMails(email)).toHaveLength(1);
    });

    it('un reembolso parcial no cambia el pedido', async () => {
      const { order } = await makeOrder();
      expect((await post(chargeEvent(order.id, { refunded: 400 }))).status).toBe(200);
      expect(await statusOf(order.id)).toBe('COMPLETED');
    });

    it('un cobro de un pedido que no existe en esta BD se responde 200 «unmatched» y NO se marca procesado', async () => {
      const id = evId();
      const body = await (await post(chargeEvent('ord_de_otro_entorno', { id }))).json();
      expect(body.unmatched).toBe(true);
      expect(await prisma.processedWebhookEvent.findUnique({ where: { id } })).toBeNull();
    });

    it('un cargo de otra cosa (sin pedido de esta plataforma) se ignora', async () => {
      vi.spyOn(StripeAdapter.prototype, 'lookupOrderId').mockResolvedValue(null);
      const res = await post(chargeEvent(null));
      expect(res.status).toBe(200);
      expect((await res.json()).unmatched).toBeUndefined();
    });

    it('un cobro anterior a P1-01 (sin metadata en el cargo) se resuelve por su sesión de Checkout', async () => {
      const { order } = await makeOrder();
      const spy = vi.spyOn(StripeAdapter.prototype, 'lookupOrderId').mockResolvedValue(order.id);
      expect((await post(chargeEvent(null))).status).toBe(200);
      expect(spy).toHaveBeenCalled();
      expect(await statusOf(order.id)).toBe('REFUNDED');
    });

    it('una disputa abierta avisa y no anula; una perdida anula; una ganada no cambia nada', async () => {
      const { order } = await makeOrder();
      await post(disputeEvent('charge.dispute.created', 'needs_response', order.id));
      expect(await statusOf(order.id)).toBe('COMPLETED');
      await post(disputeEvent('charge.dispute.closed', 'won', order.id));
      expect(await statusOf(order.id)).toBe('COMPLETED');
      await post(disputeEvent('charge.dispute.closed', 'lost', order.id));
      expect(await statusOf(order.id)).toBe('REFUNDED');
    });

    it('sin firma válida se rechaza', async () => {
      const res = await stripeWebhook(new Request('http://localhost/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: chargeEvent('x') }));
      expect(res.status).toBe(400);
    });
  });

  describe('barredera de pedidos REFUNDED con entradas activas (EN-08.1)', () => {
    const age = (id: string, minutes: number) => prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = now() - (${minutes} * interval '1 minute') WHERE "id" = ${id}`;

    it('repara uno antiguo: anula las entradas y libera el aforo, sin tocar las usadas', async () => {
      const { order } = await makeOrder({ status: 'REFUNDED', valid: 2, used: 1 });
      await age(order.id, 60);
      const before = await sold();
      const r = await repairRefundedOrders();
      expect(r.repaired).toBeGreaterThanOrEqual(1);
      expect(await ticketStatuses(order.id)).toEqual(['REFUNDED', 'REFUNDED', 'USED']);
      expect(await sold()).toBe(before - 2);
      // Idempotente: otra pasada ya no encuentra nada que reparar en él.
      const again = await sold();
      await repairRefundedOrders();
      expect(await sold()).toBe(again);
    });

    it('NO toca un reembolso reciente (puede estar en vuelo: el pedido se marca antes de llamar a la pasarela)', async () => {
      const { order } = await makeOrder({ status: 'REFUNDED', valid: 2 });
      await age(order.id, 2);
      const before = await sold();
      await repairRefundedOrders();
      expect(await ticketStatuses(order.id)).toEqual(['VALID', 'VALID']);
      expect(await sold()).toBe(before);
    });

    it('no toca pedidos que no están REFUNDED', async () => {
      const { order } = await makeOrder({ status: 'COMPLETED', valid: 2 });
      await age(order.id, 600);
      await repairRefundedOrders();
      expect(await ticketStatuses(order.id)).toEqual(['VALID', 'VALID']);
    });
  });

  describe('clave de idempotencia del reembolso (TI-09)', () => {
    it('es estable dentro de la ventana (un reintento tras un timeout no duplica) y cambia al pasarla (un fallo corregible ya no se repite 24 h)', () => {
      const t = 1_800_000_000_000;
      const k = refundIdempotencyKey('ord1', t);
      expect(k).toMatch(/^refund_ord1_\d+$/);
      expect(refundIdempotencyKey('ord1', t + 1000)).toBe(k);
      expect(refundIdempotencyKey('ord1', t + REFUND_KEY_WINDOW_MS)).not.toBe(k);
      expect(refundIdempotencyKey('ord2', t)).not.toBe(k);
    });

    it('invalidateOrder la manda a la pasarela con esa forma', async () => {
      gateway.active = true;
      const { order } = await makeOrder({ provider: 'fake' });
      const res = await invalidateOrder(order.id, 'REFUNDED');
      expect(res.success).toBe(true);
      const call = gateway.calls.find((c) => c.op === 'refund');
      expect(call?.args?.[1]).toMatch(new RegExp(`^refund_${order.id}_\\d+$`));
    });

    it('un reembolso de la app y su webhook posterior no se pisan: el webhook ve el pedido ya REFUNDED', async () => {
      gateway.active = true;
      const { order, email } = await makeOrder({ provider: 'fake' });
      await invalidateOrder(order.id, 'REFUNDED');
      expect(await applyGatewayRefund({ orderId: order.id, full: true, refunded: 10, total: 10, source: 'refund' })).toBe('already');
      expect(buyerMails(email)).toHaveLength(0); // el aviso lo da la ruta del admin, no el webhook
    });
  });

  describe('aviso al comprador (EN-08.6)', () => {
    it('sale una sola vez por pedido', async () => {
      const { order, email } = await makeOrder();
      await sendRefundEmail('entradas', { id: order.id, buyerName: 'Gr', buyerEmail: email }, 10);
      await sendRefundEmail('entradas', { id: order.id, buyerName: 'Gr', buyerEmail: email }, 10);
      expect(buyerMails(email)).toHaveLength(1);
    });

    it('si el envío falla se libera la marca y un reintento sí lo envía', async () => {
      const { order, email } = await makeOrder();
      mail.fail = true;
      await sendRefundEmail('entradas', { id: order.id, buyerName: 'Gr', buyerEmail: email }, 10);
      expect(buyerMails(email)).toHaveLength(0);
      mail.fail = false;
      await sendRefundEmail('entradas', { id: order.id, buyerName: 'Gr', buyerEmail: email }, 10);
      expect(buyerMails(email)).toHaveLength(1);
    });
  });
});
