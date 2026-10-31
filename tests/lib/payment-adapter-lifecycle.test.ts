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
    ['reembolso del importe entero sin la marca `refunded`', { id: 'ch_1', amount: 1000, amount_refunded: 1000, refunded: false }],
  ])('Stripe: %s → REFUNDED, no success, con motivo', async (_n, charge) => {
    stripeMock.retrieve.mockResolvedValue(paidSession(charge));
    const r = await stripe().verifyPayment('cs_1');
    expect(r).toMatchObject({ success: false, status: 'REFUNDED' });
    expect(r.error).toMatch(/reembolsado/);
  });

  // H-031: un reembolso PARCIAL hecho a mano NO es un reembolso total. Tratarlo como total anulaba entradas y liberaba aforo
  // y el comprador se quedaba sin el resto. Sigue siendo PAID (el dinero que queda es el de un pedido vigente) y se informa de lo devuelto.
  it('Stripe: reembolso PARCIAL (amount_refunded > 0, refunded: false) sigue siendo PAID y lleva el importe devuelto', async () => {
    stripeMock.retrieve.mockResolvedValue(paidSession({ id: 'ch_1', amount: 1000, amount_refunded: 300, refunded: false }));
    const r = await stripe().verifyPayment('cs_1');
    expect(r).toMatchObject({ success: true, status: 'PAID', amount: 10, refundedAmount: 3 });
  });

  it('Stripe: un reembolso parcial sin `amount` en el cargo tampoco es total', async () => {
    stripeMock.retrieve.mockResolvedValue(paidSession({ id: 'ch_1', amount_refunded: 300, refunded: false }));
    expect(await stripe().verifyPayment('cs_1')).toMatchObject({ status: 'PAID', refundedAmount: 3 });
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

/* P1-13: SumUp no tiene webhook y su reembolso (reescrito para reembolsar la TRANSACCIÓN, no el checkout) no estaba probado. Aquí, con `fetch` simulado,
 * se fija el contrato que sí podemos comprobar sin red: tope de tiempo en TODAS las llamadas y el comportamiento del reembolso ante cada respuesta. Que
 * SumUp responda así de verdad está por comprobar con una cuenta real (docs/platform/sumup-prueba-real.md). */
describe('SumUp (P1-13): tope de tiempo en todas las llamadas', () => {
  const seen = () => {
    const calls: { url: string; signal: AbortSignal | null | undefined; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, signal: init?.signal, method: init?.method ?? 'GET' });
        if (url.includes('/refunds')) return new Response('{}', { status: 200 });
        if (url.endsWith('/v0.1/checkouts') && init?.method === 'POST') return new Response(JSON.stringify({ id: 'co_1', hosted_checkout_url: 'https://pay.sumup.test/co_1' }), { status: 201 });
        return new Response(JSON.stringify({ status: 'PAID', transactions: [{ id: 'tx_1', status: 'SUCCESSFUL', amount: 25.5 }] }), { status: 200 });
      })
    );
    return calls;
  };
  const adapter = () => new SumUpAdapter('key', 'MERCHANT1');

  it('prueba de conexión, crear checkout, verificar y reembolsar (consulta + reembolso) llevan una señal de cancelación viva', async () => {
    const calls = seen();
    await adapter().testConnection();
    await adapter().createCheckoutSession(params);
    await adapter().verifyPayment('co_1');
    await adapter().refund('co_1');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v0.1/merchants/MERCHANT1',
      'POST /v0.1/checkouts',
      'GET /v0.1/checkouts/co_1',
      'GET /v0.1/checkouts/co_1',
      'POST /v1.0/merchants/MERCHANT1/payments/tx_1/refunds',
    ]);
    for (const c of calls) {
      expect(c.signal, c.url).toBeInstanceOf(AbortSignal);
      expect(c.signal!.aborted, c.url).toBe(false);
    }
  });

  it('si SumUp no contesta al crear el checkout, la llamada FALLA (la ruta de compra cancela el pedido y libera el aforo) en vez de colgarse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
    await expect(adapter().createCheckoutSession(params)).rejects.toThrow(/timeout/i);
  });

  it('la prueba de conexión que vence devuelve {ok: false} con el motivo, sin lanzar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
    expect(await adapter().testConnection()).toMatchObject({ ok: false, error: expect.stringMatching(/timeout/i) });
  });
});

describe('SumUp (P1-13): reembolso de la transacción del checkout', () => {
  type Step = { status: number; body: unknown };
  /** Respuestas en orden: 1.ª la consulta del checkout, 2.ª el reembolso. Guarda lo enviado. */
  const scripted = (...steps: Step[]) => {
    const sent: { url: string; method: string; body: unknown }[] = [];
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const step = steps[Math.min(i, steps.length - 1)];
        i += 1;
        return new Response(JSON.stringify(step.body), { status: step.status });
      })
    );
    return sent;
  };
  const adapter = () => new SumUpAdapter('key', 'M/1'); // con una barra: se codifica en la URL
  const charged = (amount = 25.5) => ({ status: 200, body: { status: 'PAID', transactions: [{ id: 'tx 1', status: 'SUCCESSFUL', amount }] } });

  it('reembolso total: consulta el checkout, reembolsa SU transacción (ids codificados) y el cuerpo va vacío', async () => {
    const sent = scripted(charged(), { status: 200, body: {} });
    expect(await adapter().refund('co/1')).toEqual({ success: true, refundId: 'tx 1' });
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'https://api.sumup.com/v0.1/checkouts/co%2F1' });
    expect(sent[1]).toMatchObject({ method: 'POST', url: 'https://api.sumup.com/v1.0/merchants/M%2F1/payments/tx%201/refunds', body: {} });
  });

  it('importe menor que lo cobrado = reembolso parcial (con importe); igual (o sin importe) = total (sin importe)', async () => {
    const partial = scripted(charged(), { status: 200, body: {} });
    expect(await adapter().refund('co_1', 10)).toMatchObject({ success: true });
    expect(partial[1].body).toEqual({ amount: 10 });
    const equal = scripted(charged(), { status: 200, body: {} });
    await adapter().refund('co_1', 25.5);
    expect(equal[1].body).toEqual({});
    const none = scripted(charged(), { status: 200, body: {} });
    await adapter().refund('co_1');
    expect(none[1].body).toEqual({});
  });

  it('un importe que no es positivo o que supera lo cobrado se RECHAZA: no se convierte en silencio en una devolución completa', async () => {
    for (const bad of [0, -5, 99, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sent = scripted(charged(), { status: 200, body: {} });
      const r = await adapter().refund('co_1', bad);
      expect(r, String(bad)).toMatchObject({ success: false, error: expect.stringMatching(/Importe de reembolso no válido/) });
      expect(sent.filter((x) => x.method === 'POST'), String(bad)).toHaveLength(0); // no sale ninguna orden de reembolso
    }
  });

  it('un reintento sobre una transacción YA reembolsada es éxito y no vuelve a reembolsar (SumUp no tiene clave de idempotencia)', async () => {
    const sent = scripted({ status: 200, body: { status: 'PAID', transactions: [{ id: 'tx_9', status: 'REFUNDED', amount: 25.5 }] } });
    expect(await adapter().refund('co_1')).toEqual({ success: true, refundId: 'tx_9' });
    expect(sent).toHaveLength(1); // solo la consulta
  });

  it('un checkout sin transacción cobrada no reembolsa nada y lo dice', async () => {
    const sent = scripted({ status: 200, body: { status: 'PENDING', transactions: [] } });
    const r = await adapter().refund('co_1');
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/no hay nada que reembolsar/) });
    expect(sent).toHaveLength(1);
    scripted({ status: 200, body: { status: 'PENDING' } }); // sin lista
    expect((await adapter().refund('co_1')).success).toBe(false);
  });

  it('errores de SumUp: al consultar y al reembolsar, con su mensaje (y uno genérico con el código si no trae)', async () => {
    scripted({ status: 404, body: { message: 'Checkout not found' } });
    expect(await adapter().refund('co_1')).toEqual({ success: false, error: 'Checkout not found' });
    scripted(charged(), { status: 409, body: { detail: 'Transaction already refunded' } });
    expect(await adapter().refund('co_1')).toEqual({ success: false, error: 'Transaction already refunded' });
    scripted(charged(), { status: 500, body: null });
    expect(await adapter().refund('co_1')).toEqual({ success: false, error: 'SumUp devolvió 500 al reembolsar' });
  });

  it('si la red falla o vence el tiempo, devuelve {success: false} con el motivo, sin lanzar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
    expect(await adapter().refund('co_1')).toMatchObject({ success: false, error: expect.stringMatching(/timeout/i) });
  });
});
