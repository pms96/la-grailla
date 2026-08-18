import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';

const TEST_SECRET_KEY = 'sk_test_fake_for_signature_only';
const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_vitest';

function signPayload(payload: string, secret: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function webhookRequest(payload: string, signature: string | null) {
  return new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
    body: payload,
  });
}

async function createPendingOrder(eventId: string, ticketTypeId: string, paymentId: string) {
  return prisma.order.create({
    data: {
      eventId, buyerName: 'Test', buyerLastName: 'Webhook', buyerEmail: 'test-webhook@example.com',
      totalAmount: 10, paymentProvider: 'stripe', paymentId, status: 'PENDING',
      tickets: { create: { eventId, ticketTypeId, qrCode: `QR-WH-${Date.now()}-${Math.random()}`, holderName: 'Test Webhook', status: 'PENDING' } },
    },
    include: { tickets: true },
  });
}

describe('POST /api/webhooks/stripe', () => {
  let originalSecretKey: string | null;
  let originalWebhookSecret: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;

  beforeAll(async () => {
    originalSecretKey = await getAndSetConfig('stripe_secret_key', TEST_SECRET_KEY);
    originalWebhookSecret = await getAndSetConfig('stripe_webhook_secret', TEST_WEBHOOK_SECRET);
    event = await createTestEvent();
    ticketType = await createTicketType(event.id, { maxQuantity: 20 });
  });

  afterAll(async () => {
    await restoreConfig('stripe_secret_key', originalSecretKey);
    await restoreConfig('stripe_webhook_secret', originalWebhookSecret);
    await cleanupTestEvent(event.id);
  });

  it('rechaza un payload con firma inválida', async () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const res = await stripeWebhook(webhookRequest(payload, 't=1,v1=deadbeef'));
    expect(res.status).toBe(400);
  });

  it('rechaza un payload sin cabecera stripe-signature', async () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const res = await stripeWebhook(webhookRequest(payload, null));
    expect(res.status).toBe(400);
  });

  it('checkout.session.completed completa el pedido y valida las entradas', async () => {
    const order = await createPendingOrder(event.id, ticketType.id, 'cs_test_completed');
    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_completed', payment_status: 'paid', metadata: { orderId: order.id } } },
    });

    const res = await stripeWebhook(webhookRequest(payload, signPayload(payload, TEST_WEBHOOK_SECRET)));
    expect(res.status).toBe(200);

    const updated = await prisma.order.findUnique({ where: { id: order.id }, include: { tickets: true } });
    expect(updated?.status).toBe('COMPLETED');
    expect(updated?.tickets[0].status).toBe('VALID');

    // Reenviar el mismo evento (Stripe reintenta si no responde 200 a tiempo)
    // no debe fallar ni revertir nada — debe seguir siendo un no-op.
    const resRetry = await stripeWebhook(webhookRequest(payload, signPayload(payload, TEST_WEBHOOK_SECRET)));
    expect(resRetry.status).toBe(200);
    const stillUpdated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(stillUpdated?.status).toBe('COMPLETED');
  });

  it('checkout.session.expired cancela el pedido y libera el stock reservado', async () => {
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: 0 } });
    const order = await createPendingOrder(event.id, ticketType.id, 'cs_test_expired');
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: { increment: 1 } } });

    const payload = JSON.stringify({
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_test_expired', metadata: { orderId: order.id } } },
    });
    const res = await stripeWebhook(webhookRequest(payload, signPayload(payload, TEST_WEBHOOK_SECRET)));
    expect(res.status).toBe(200);

    const updated = await prisma.order.findUnique({ where: { id: order.id }, include: { tickets: true } });
    expect(updated?.status).toBe('CANCELLED');
    expect(updated?.tickets[0].status).toBe('CANCELLED');

    const updatedTicketType = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(updatedTicketType?.soldCount).toBe(0);
  });

  it('no reactiva un pedido que ya estaba CANCELLED al reenviar el evento de expiración', async () => {
    const order = await createPendingOrder(event.id, ticketType.id, 'cs_test_already_cancelled');
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });

    const payload = JSON.stringify({
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_test_already_cancelled', metadata: { orderId: order.id } } },
    });
    const res = await stripeWebhook(webhookRequest(payload, signPayload(payload, TEST_WEBHOOK_SECRET)));
    expect(res.status).toBe(200);

    const ticketTypeAfter = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    // No debe decrementar soldCount dos veces por un pedido que ya se había liberado.
    expect(ticketTypeAfter?.soldCount).toBeGreaterThanOrEqual(0);
  });
});
