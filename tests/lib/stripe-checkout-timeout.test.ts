import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StripeAdapter } from '@/lib/payment-adapter';

/* H-217 (fase 5, ronda 2): `maxDuration = 60` de las rutas de pedido supone «cerrojo 20 s + transacción 20 s + pasarela ≤ 12 s». La sesión de Stripe se creaba con el
 * `timeout` por defecto del SDK (80 s): con Stripe lento tras el commit, la función moría antes de guardar `paymentId` y el pedido quedaba PENDING reteniendo aforo. */

const stripeMock = vi.hoisted(() => ({ create: vi.fn(), ctorOptions: [] as unknown[] }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    checkout = { sessions: { create: stripeMock.create } };
    constructor(_key: string, options: unknown) {
      stripeMock.ctorOptions.push(options);
    }
  },
}));

beforeEach(() => {
  stripeMock.create.mockReset();
  stripeMock.ctorOptions.length = 0;
});

describe('Stripe: crear la sesión de pago cabe en el presupuesto del checkout', () => {
  it('el cliente de la sesión lleva un timeout ≤ 12 s y sin reintentos automáticos (la idempotencyKey ya protege un reintento nuestro)', async () => {
    stripeMock.create.mockResolvedValue({ id: 'cs_1', url: 'https://pay.example/cs_1' });
    await new StripeAdapter('sk_test_fake').createCheckoutSession({ amount: 10, currency: 'EUR', description: 'Entradas', orderId: 'ord_1', successUrl: 'https://x/ok', cancelUrl: 'https://x/ko', customerEmail: 'a@b.c' });
    const options = stripeMock.ctorOptions[0] as { timeout?: number; maxNetworkRetries?: number };
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(12_000);
    expect(options.maxNetworkRetries).toBe(0);
  });
});
