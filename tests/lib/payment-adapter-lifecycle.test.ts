import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripeAdapter, SumUpAdapter, effectiveStatus } from '@/lib/payment-adapter';
import { CHECKOUT_HOLD_MINUTES, CHECKOUT_RELEASE_AFTER_MS, STRIPE_EXPIRES_AT_MARGIN_SECONDS } from '@/lib/checkout-hold';

/* Ciclo de vida de la sesión de pago en los adaptadores (P0-06, P0-05, P0-04): la verificación que falla es UNKNOWN, la sesión se crea con
 * caducidad, y se puede cerrar. Sin red: el SDK de Stripe y el fetch de SumUp están simulados. */

const stripeMock = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
  refundCreate: vi.fn(),
  construct: vi.fn(),
}));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    checkout = { sessions: { create: stripeMock.create, retrieve: stripeMock.retrieve, expire: stripeMock.expire } };
    refunds = { create: stripeMock.refundCreate };
    constructor() {
      if (stripeMock.construct.getMockImplementation()) stripeMock.construct();
    }
  },
}));

const params = { amount: 25.5, currency: 'EUR', description: 'Entradas', orderId: 'ord_1', successUrl: 'https://x/ok', cancelUrl: 'https://x/ko', customerEmail: 'a@b.c' };

beforeEach(() => {
  for (const fn of Object.values(stripeMock)) fn.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('Stripe: una verificación que FALLA es UNKNOWN con error (nunca «no pagado»)', () => {
  const stripe = () => new StripeAdapter('sk_test_fake');

  it('la API lanza (clave caducada, red caída): status UNKNOWN, success false y el motivo', async () => {
    stripeMock.retrieve.mockRejectedValue(new Error('Invalid API Key provided: sk_test_***'));
    const r = await stripe().verifyPayment('cs_1');
    expect(r).toMatchObject({ success: false, status: 'UNKNOWN', provider: 'stripe', paymentId: 'cs_1' });
    expect(r.error).toMatch(/Invalid API Key/);
    expect(effectiveStatus(r)).toBe('UNKNOWN');
  });

  it('incluso si el constructor del SDK lanza (clave ilegible), no se propaga la excepción', async () => {
    stripeMock.construct.mockImplementation(() => {
      throw new Error('clave ilegible');
    });
    expect(await stripe().verifyPayment('cs_1')).toMatchObject({ success: false, status: 'UNKNOWN', error: 'clave ilegible' });
  });

  it('una sesión en un estado que no se reconoce también es UNKNOWN con error', async () => {
    stripeMock.retrieve.mockResolvedValue({ id: 'cs_1', status: 'raro', payment_status: 'unpaid' });
    expect(await stripe().verifyPayment('cs_1')).toMatchObject({ success: false, status: 'UNKNOWN' });
  });

  it.each([
    [{ id: 'cs_1', status: 'open', payment_status: 'unpaid' }, 'PENDING'],
    [{ id: 'cs_1', status: 'complete', payment_status: 'unpaid' }, 'PROCESSING'],
    [{ id: 'cs_1', status: 'complete', payment_status: 'paid', amount_total: 2550, currency: 'eur' }, 'PAID'],
    [{ id: 'cs_1', status: 'expired', payment_status: 'unpaid' }, 'EXPIRED'],
  ])('sesión %j → %s', async (session, expected) => {
    stripeMock.retrieve.mockResolvedValue(session);
    const r = await stripe().verifyPayment('cs_1');
    expect(r.status).toBe(expected);
    expect(r.success).toBe(expected === 'PAID');
  });
});

describe('SumUp: una verificación que FALLA es UNKNOWN con error', () => {
  const sumup = () => new SumUpAdapter('key', 'M1');
  const stub = (impl: () => unknown) => vi.stubGlobal('fetch', vi.fn(async () => impl()));

  it.each([
    ['la red lanza', () => { throw new Error('ECONNRESET'); }],
    ['el cuerpo no es JSON', () => new Response('<html>', { status: 200 })],
    ['HTTP 401', () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })],
    ['estado desconocido', () => new Response(JSON.stringify({ status: 'NUEVO' }), { status: 200 })],
    ['200 sin cuerpo', () => new Response('null', { status: 200 })],
  ])('%s', async (_n, impl) => {
    stub(impl);
    const r = await sumup().verifyPayment('co_1');
    expect(r).toMatchObject({ success: false, status: 'UNKNOWN', provider: 'sumup' });
    expect(r.error).toBeTruthy();
  });
});

describe('caducidad de la sesión (P0-04)', () => {
  it('la constante de retención es de 30 minutos, el mínimo que admite Stripe', () => {
    expect(CHECKOUT_HOLD_MINUTES).toBe(30);
  });

  it('Stripe: la sesión se crea con expires_at = ahora + CHECKOUT_HOLD_MINUTES, en segundos UNIX', async () => {
    stripeMock.create.mockResolvedValue({ id: 'cs_1', url: 'https://pay' });
    const before = Math.floor(Date.now() / 1000);
    await new StripeAdapter('sk_test_fake').createCheckoutSession(params);
    const after = Math.floor(Date.now() / 1000);
    const sent = stripeMock.create.mock.calls[0][0];
    expect(Number.isInteger(sent.expires_at)).toBe(true);
    expect(sent.expires_at).toBeGreaterThanOrEqual(before + CHECKOUT_HOLD_MINUTES * 60);
    expect(sent.expires_at).toBeLessThanOrEqual(after + CHECKOUT_HOLD_MINUTES * 60 + STRIPE_EXPIRES_AT_MARGIN_SECONDS);
    // Stripe exige entre 30 min y 24 h DESDE QUE ELLA CREA la sesión: con un margen para la latencia, nunca por debajo de 30 min.
    expect(sent.expires_at - after).toBeGreaterThanOrEqual(30 * 60);
    expect(sent.expires_at - before).toBeLessThanOrEqual(24 * 3600);
    // Y la caducidad cae siempre ANTES de que el cron se plantee liberar el pedido.
    expect((sent.expires_at - before) * 1000).toBeLessThan(CHECKOUT_RELEASE_AFTER_MS);
  });

  it('SumUp: el checkout se crea con valid_until ISO 8601 = ahora + CHECKOUT_HOLD_MINUTES', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'co_1', hosted_checkout_url: 'https://pay' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const before = Date.now();
    await new SumUpAdapter('key', 'M1').createCheckoutSession(params);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.valid_until).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    const at = new Date(body.valid_until).getTime();
    expect(at).toBeGreaterThanOrEqual(before + CHECKOUT_HOLD_MINUTES * 60_000 - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + CHECKOUT_HOLD_MINUTES * 60_000 + 1000);
  });
});

describe('cancelPayment: cerrar la sesión viva', () => {
  it('Stripe: expira la sesión', async () => {
    stripeMock.expire.mockResolvedValue({ id: 'cs_1', status: 'expired' });
    expect(await new StripeAdapter('sk').cancelPayment('cs_1')).toEqual({ ok: true });
    expect(stripeMock.expire).toHaveBeenCalledWith('cs_1');
  });

  it('Stripe: si ya estaba expirada, se da por cerrada', async () => {
    stripeMock.expire.mockRejectedValue(new Error('Only open Checkout Sessions can be expired'));
    stripeMock.retrieve.mockResolvedValue({ id: 'cs_1', status: 'expired', payment_status: 'unpaid' });
    expect(await new StripeAdapter('sk').cancelPayment('cs_1')).toEqual({ ok: true });
  });

  it('Stripe: si ya estaba completa/pagada NO se puede cerrar (ok false) para que quien llama vuelva a verificar', async () => {
    stripeMock.expire.mockRejectedValue(new Error('Only open Checkout Sessions can be expired'));
    stripeMock.retrieve.mockResolvedValue({ id: 'cs_1', status: 'complete', payment_status: 'paid' });
    const r = await new StripeAdapter('sk').cancelPayment('cs_1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/open Checkout Sessions/);
  });

  it('Stripe: un fallo de red no lanza', async () => {
    stripeMock.expire.mockRejectedValue(new Error('red'));
    stripeMock.retrieve.mockRejectedValue(new Error('red'));
    expect(await new StripeAdapter('sk').cancelPayment('cs_1')).toMatchObject({ ok: false, error: 'red' });
  });

  it('SumUp: DELETE /v0.1/checkouts/{id} con la clave de la cuenta', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'co_1', status: 'EXPIRED' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new SumUpAdapter('key_9', 'M1').cancelPayment('co_1')).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe('https://api.sumup.com/v0.1/checkouts/co_1');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer key_9');
  });

  it('SumUp: 409 CHECKOUT_PROCESSED (ya procesado) = no cerrado, con el motivo; y un fallo de red no lanza', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Checkout is already processed.' }), { status: 409 })));
    expect(await new SumUpAdapter('k', 'M').cancelPayment('co_1')).toEqual({ ok: false, error: 'Checkout is already processed.' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    expect(await new SumUpAdapter('k', 'M').cancelPayment('co_1')).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('las capacidades lo declaran: Stripe y SumUp pueden cerrar la sesión, el simulado no', async () => {
    const { MockPaymentAdapter } = await import('@/lib/payment-adapter');
    expect(new StripeAdapter('sk').capabilities.cancelCheckout).toBe(true);
    expect(new SumUpAdapter('k', 'M').capabilities.cancelCheckout).toBe(true);
    expect(new MockPaymentAdapter().capabilities.cancelCheckout).toBe(false);
    expect((new MockPaymentAdapter() as { cancelPayment?: unknown }).cancelPayment).toBeUndefined();
  });
});

describe('reembolso: ya reembolsado es éxito', () => {
  it('Stripe charge_already_refunded (p. ej. un reintento pasadas las 24 h de la clave de idempotencia) se da por hecho', async () => {
    stripeMock.retrieve.mockResolvedValue({ id: 'cs_1', payment_intent: 'pi_1' });
    stripeMock.refundCreate.mockRejectedValue(Object.assign(new Error('Charge has already been refunded.'), { code: 'charge_already_refunded' }));
    expect(await new StripeAdapter('sk').refund('cs_1', undefined, 'late_o1')).toEqual({ success: true });
    expect(stripeMock.refundCreate.mock.calls[0][1]).toEqual({ idempotencyKey: 'late_o1' });
  });

  it('otro error de Stripe sigue siendo un fallo', async () => {
    stripeMock.retrieve.mockResolvedValue({ id: 'cs_1', payment_intent: 'pi_1' });
    stripeMock.refundCreate.mockRejectedValue(Object.assign(new Error('insufficient funds'), { code: 'balance_insufficient' }));
    expect(await new StripeAdapter('sk').refund('cs_1')).toEqual({ success: false, error: 'insufficient funds' });
  });
});

describe('reembolsos hechos a mano (M2): verifyPayment los detecta', () => {
  const stripe = () => new StripeAdapter('sk_test_fake');
  const paidSession = (charge: unknown, extra: Record<string, unknown> = {}) => ({ id: 'cs_1', status: 'complete', payment_status: 'paid', amount_total: 1000, currency: 'eur', payment_intent: charge === undefined ? 'pi_1' : { id: 'pi_1', latest_charge: charge }, ...extra });

  it('Stripe pide el cargo en la MISMA llamada (expand), sin peticiones extra', async () => {
    stripeMock.retrieve.mockResolvedValue(paidSession({ id: 'ch_1', amount_refunded: 0, refunded: false }));
    await stripe().verifyPayment('cs_1');
    expect(stripeMock.retrieve).toHaveBeenCalledTimes(1);
    expect(stripeMock.retrieve).toHaveBeenCalledWith('cs_1', { expand: ['payment_intent.latest_charge'] });
  });

  it('pagada y NO reembolsada sigue siendo PAID (con importe)', async () => {
    stripeMock.retrieve.mockResolvedValue(paidSession({ id: 'ch_1', amount_refunded: 0, refunded: false }));
    expect(await stripe().verifyPayment('cs_1')).toMatchObject({ success: true, status: 'PAID', amount: 10, currency: 'EUR' });
  });

  it.each([
    ['reembolso total (refunded: true)', { id: 'ch_1', amount_refunded: 1000, refunded: true }],
    ['reembolso PARCIAL (amount_refunded > 0, refunded: false)', { id: 'ch_1', amount_refunded: 300, refunded: false }],
  ])('Stripe: %s → REFUNDED, no success, con motivo', async (_n, charge) => {
    stripeMock.retrieve.mockResolvedValue(paidSession(charge));
    const r = await stripe().verifyPayment('cs_1');
    expect(r).toMatchObject({ success: false, status: 'REFUNDED' });
    expect(r.error).toMatch(/reembolsado/);
  });

  it('si el cargo no viene expandido (string o null) no se inventa un reembolso: PAID como siempre', async () => {
    stripeMock.retrieve.mockResolvedValue(paidSession('ch_1'));
    expect((await stripe().verifyPayment('cs_1')).status).toBe('PAID');
    stripeMock.retrieve.mockResolvedValue(paidSession(null));
    expect((await stripe().verifyPayment('cs_1')).status).toBe('PAID');
    stripeMock.retrieve.mockResolvedValue(paidSession(undefined));
    expect((await stripe().verifyPayment('cs_1')).status).toBe('PAID');
  });

  it('una sesión sin pagar nunca es REFUNDED', async () => {
    stripeMock.retrieve.mockResolvedValue({ id: 'cs_1', status: 'open', payment_status: 'unpaid', payment_intent: { latest_charge: { amount_refunded: 500 } } });
    expect((await stripe().verifyPayment('cs_1')).status).toBe('PENDING');
  });

  const sumup = (body: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    return new SumUpAdapter('k', 'M');
  };
  it('SumUp: checkout PAID con una transacción REFUNDED → REFUNDED (total o parcial)', async () => {
    const r = await sumup({ status: 'PAID', amount: 10, currency: 'EUR', transactions: [{ id: 't1', status: 'REFUNDED', amount: 10 }] }).verifyPayment('co_1');
    expect(r).toMatchObject({ success: false, status: 'REFUNDED' });
  });
  it('SumUp: checkout PAID con transacción SUCCESSFUL (o sin lista) sigue siendo PAID', async () => {
    expect(await sumup({ status: 'PAID', amount: 10, currency: 'EUR', transactions: [{ id: 't1', status: 'SUCCESSFUL' }] }).verifyPayment('co_1')).toMatchObject({ success: true, status: 'PAID' });
    expect((await sumup({ status: 'PAID', amount: 10 }).verifyPayment('co_1')).status).toBe('PAID');
  });
  it('SumUp: una transacción REFUNDED en un checkout que no está PAID no cambia el estado', async () => {
    expect((await sumup({ status: 'PENDING', transactions: [{ status: 'REFUNDED' }] }).verifyPayment('co_1')).status).toBe('PENDING');
  });
});
