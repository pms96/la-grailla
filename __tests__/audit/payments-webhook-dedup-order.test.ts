// AUDIT: PAY-05 — el webhook de Stripe insertaba la fila de ProcessedWebhookEvent
// ANTES de procesar el evento (completeOrder/completeShopOrder). Si el procesamiento
// lanzaba una excepción (fallo transitorio de BD, bug), el evento ya había quedado
// marcado como "procesado": el reintento automático de Stripe (en minutos) chocaba
// con la constraint única y salía como `duplicate: true` SIN volver a intentar
// completar el pedido — quedaba PENDING hasta que el cron de reconciliación (que
// corre con un intervalo mucho mayor) lo recogiera.
//
// Se movió el insert a después de procesar con éxito, dejando solo una lectura
// (findUnique) antes, para no reprocesar de más el caso común de un reintento tras
// éxito. Este test mockea resolvePaidCheckout para que falle la primera vez y
// confirma que (a) el evento NO queda marcado como procesado tras el fallo y (b) un
// reintento del mismo evento sí completa el pedido.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../../tests/helpers/fixtures';

const TEST_SECRET_KEY = 'sk_test_fake_for_signature_only';
const TEST_WEBHOOK_SECRET = 'whsec_test_secret_pay05';

let shouldFailOnce = true;

vi.mock('@/lib/order-reconciliation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-reconciliation')>('@/lib/order-reconciliation');
  return {
    ...actual,
    resolvePaidCheckout: vi.fn(async (orderId: string, baseUrl?: string) => {
      if (shouldFailOnce) {
        shouldFailOnce = false;
        throw new Error('Fallo simulado de procesamiento (PAY-05)');
      }
      return actual.resolvePaidCheckout(orderId, baseUrl);
    }),
  };
});

const { POST: stripeWebhook } = await import('@/app/api/webhooks/stripe/route');

function signPayload(payload: string, secret: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function webhookRequest(payload: string, signature: string) {
  return new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

describe('AUDIT — el webhook no marca un evento como procesado si el procesamiento falla', () => {
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
    await prisma.processedWebhookEvent.deleteMany({ where: { id: 'evt_test_pay05' } });
    await cleanupTestEvent(event.id);
  });

  it('un reintento tras un fallo de procesamiento SÍ completa el pedido', async () => {
    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Test',
        buyerLastName: 'PAY05',
        buyerEmail: 'test-pay05@example.com',
        totalAmount: 10,
        paymentProvider: 'stripe',
        paymentId: 'cs_test_pay05',
        status: 'PENDING',
        tickets: {
          create: {
            eventId: event.id,
            ticketTypeId: ticketType.id,
            qrCode: `QR-PAY05-${Date.now()}`,
            holderName: 'Test PAY05',
            status: 'PENDING',
          },
        },
      },
    });

    const payload = JSON.stringify({
      id: 'evt_test_pay05',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_pay05', payment_status: 'paid', metadata: { orderId: order.id } } },
    });

    // Primer intento: resolvePaidCheckout lanza — el webhook debe devolver
    // un error (no 200) y el pedido debe seguir PENDING.
    const resFail = await stripeWebhook(webhookRequest(payload, signPayload(payload, TEST_WEBHOOK_SECRET)));
    expect(resFail.status).not.toBe(200);

    const afterFailure = await prisma.order.findUnique({ where: { id: order.id } });
    expect(afterFailure?.status).toBe('PENDING');

    const notMarkedProcessed = await prisma.processedWebhookEvent.findUnique({ where: { id: 'evt_test_pay05' } });
    expect(notMarkedProcessed).toBeNull();

    // Reintento (Stripe reintenta automáticamente tras un 5xx): esta vez
    // resolvePaidCheckout no falla y el pedido se completa de verdad.
    const resRetry = await stripeWebhook(webhookRequest(payload, signPayload(payload, TEST_WEBHOOK_SECRET)));
    expect(resRetry.status).toBe(200);

    const afterRetry = await prisma.order.findUnique({ where: { id: order.id } });
    expect(afterRetry?.status).toBe('COMPLETED');

    const nowMarkedProcessed = await prisma.processedWebhookEvent.findUnique({ where: { id: 'evt_test_pay05' } });
    expect(nowMarkedProcessed).not.toBeNull();
  });
});
