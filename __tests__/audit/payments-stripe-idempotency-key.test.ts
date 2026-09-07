// AUDIT: PAY-06 — las llamadas a stripe.checkout.sessions.create y
// stripe.refunds.create no pasaban idempotencyKey. Un timeout de red hacia
// Stripe (la operación se completa en su lado pero la respuesta no llega a
// nuestro servidor) podía traducirse, si algo reintentaba la llamada, en una
// segunda sesión de checkout o un segundo reembolso real para el mismo
// pedido — Stripe soporta idempotencyKey precisamente para esto: con la
// misma clave, devuelve el recurso ya creado en vez de duplicarlo.
//
// Se mockea el paquete `stripe` para capturar las opciones con las que se
// invoca create(), sin llamar a la API real.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionsCreate = vi.fn(async (_params: unknown, _options?: { idempotencyKey?: string }) => ({
  id: 'cs_test_123',
  url: 'https://checkout.stripe.com/test',
}));
const sessionsRetrieve = vi.fn(async () => ({ id: 'cs_test_123', payment_intent: 'pi_test_123' }));
const refundsCreate = vi.fn(async (_params: unknown, _options?: { idempotencyKey?: string }) => ({
  id: 're_test_123',
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    checkout = { sessions: { create: sessionsCreate, retrieve: sessionsRetrieve } };
    refunds = { create: refundsCreate };
  },
}));

const { StripeAdapter } = await import('@/lib/payment-adapter');

describe('AUDIT — StripeAdapter pasa idempotencyKey a Stripe', () => {
  beforeEach(() => {
    sessionsCreate.mockClear();
    sessionsRetrieve.mockClear();
    refundsCreate.mockClear();
  });

  it('createCheckoutSession incluye idempotencyKey derivada del orderId', async () => {
    const adapter = new StripeAdapter('sk_test_x');
    await adapter.createCheckoutSession({
      amount: 20,
      currency: 'eur',
      description: 'Entrada test',
      orderId: 'order_abc123',
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel',
      customerEmail: 'test@example.com',
    });

    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [, options] = sessionsCreate.mock.calls[0];
    expect(options).toMatchObject({ idempotencyKey: 'checkout_order_abc123' });
  });

  it('refund incluye la idempotencyKey recibida', async () => {
    const adapter = new StripeAdapter('sk_test_x');
    await adapter.refund('cs_test_123', 20, 'refund_order_abc123');

    expect(refundsCreate).toHaveBeenCalledTimes(1);
    const [, options] = refundsCreate.mock.calls[0];
    expect(options).toMatchObject({ idempotencyKey: 'refund_order_abc123' });
  });

  it('refund sin idempotencyKey no rompe (sigue funcionando como antes)', async () => {
    const adapter = new StripeAdapter('sk_test_x');
    const result = await adapter.refund('cs_test_123', 20);
    expect(result.success).toBe(true);
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });
});
