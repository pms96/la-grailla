import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import {
  MockPaymentAdapter,
  StripeAdapter,
  SumUpAdapter,
  WebhookRejected,
  mapStripeSessionStatus,
  mapSumUpStatus,
  type PaymentProvider,
} from '@/lib/payment-adapter';

/* PaymentProvider ampliado (M6): capacidades declaradas, estado de cobro normalizado y webhooks traducidos a eventos neutros. */

const SECRET = 'whsec_unit_test_secret';
const sign = (payload: string, secret = SECRET) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
};
const headers = (signature?: string) => new Headers(signature ? { 'stripe-signature': signature } : {});
const stripe = (webhookSecret = SECRET, key = 'sk_test_fake') => new StripeAdapter(key, async () => webhookSecret);
const event = (type: string, object: Record<string, unknown>, id = 'evt_1') => JSON.stringify({ id, type, data: { object } });

describe('capacidades', () => {
  const providers: PaymentProvider[] = [stripe(), new SumUpAdapter('key', 'M123'), new MockPaymentAdapter()];

  it('cada proveedor declara lo que sabe hacer y parseWebhook existe si y solo si declara webhooks', () => {
    for (const p of providers) {
      expect(typeof p.capabilities.refunds, p.name).toBe('boolean');
      expect(typeof p.parseWebhook === 'function', p.name).toBe(p.capabilities.webhooks);
      // Ningún proveedor declara cobro presencial todavía, y por tanto ninguno lo implementa.
      expect(p.capabilities.inPerson, p.name).toBe(false);
      expect(p.createInPersonPayment, p.name).toBeUndefined();
    }
  });

  it('Stripe: webhooks y reembolsos idempotentes; SumUp: sin webhook y sin idempotencia', () => {
    expect(stripe().capabilities).toMatchObject({ webhooks: true, idempotentRefunds: true, partialRefunds: true });
    expect(new SumUpAdapter('k', 'M').capabilities).toMatchObject({ webhooks: false, idempotentRefunds: false, partialRefunds: false });
  });
});

describe('estado de cobro normalizado', () => {
  it.each([
    [{ payment_status: 'paid', status: 'complete' }, 'PAID'],
    [{ payment_status: 'unpaid', status: 'open' }, 'PENDING'],
    [{ payment_status: 'unpaid', status: 'expired' }, 'EXPIRED'],
    [{ payment_status: 'paid', status: 'expired' }, 'PAID'], // pagado manda sobre caducado
    // Sesión completa pero sin pagar (medios de pago asíncronos): el dinero está en camino, NO es «pendiente» y jamás se libera por tiempo.
    [{ payment_status: 'unpaid', status: 'complete' }, 'PROCESSING'],
    [{ payment_status: 'no_payment_required', status: 'complete' }, 'PROCESSING'],
    [{ payment_status: 'unpaid' }, 'UNKNOWN'], // sin `status` no se sabe si está abierta: ante la duda, nunca «no pagado»
    [{}, 'UNKNOWN'],
  ])('Stripe %j → %s', (session, expected) => {
    expect(mapStripeSessionStatus(session)).toBe(expected);
  });

  it.each([
    ['PAID', 'PAID'],
    ['PENDING', 'PENDING'],
    ['FAILED', 'FAILED'],
    ['EXPIRED', 'EXPIRED'],
    ['algo-nuevo', 'UNKNOWN'],
    [undefined, 'UNKNOWN'],
  ])('SumUp %s → %s', (raw, expected) => {
    expect(mapSumUpStatus(raw)).toBe(expected);
  });

  describe('SumUp.verifyPayment', () => {
    afterEach(() => vi.unstubAllGlobals());
    const respond = (ok: boolean, status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status, json: async () => body })));

    it('pagado: success, estado y el importe que dice haber cobrado la pasarela', async () => {
      respond(true, 200, { status: 'PAID', amount: 25.5, currency: 'EUR' });
      expect(await new SumUpAdapter('k', 'M').verifyPayment('co_1')).toMatchObject({ success: true, status: 'PAID', amount: 25.5, currency: 'EUR' });
    });
    it('pendiente y fallido no son success', async () => {
      respond(true, 200, { status: 'PENDING' });
      expect(await new SumUpAdapter('k', 'M').verifyPayment('co_1')).toMatchObject({ success: false, status: 'PENDING' });
      respond(true, 200, { status: 'FAILED' });
      expect(await new SumUpAdapter('k', 'M').verifyPayment('co_1')).toMatchObject({ success: false, status: 'FAILED' });
    });
    it('un error de la API no se confunde con un estado: UNKNOWN y sin importe', async () => {
      respond(false, 404, { message: 'Not found' });
      const r = await new SumUpAdapter('k', 'M').verifyPayment('co_1');
      expect(r).toMatchObject({ success: false, status: 'UNKNOWN', error: 'Not found' });
      expect(r.amount).toBeUndefined();
    });
  });

  /* SumUp reembolsa TRANSACCIONES, no checkouts: el `paymentId` de un pedido es el id del checkout, así que primero se lee el checkout para
   * sacar la transacción cobrada y luego se reembolsa esa (POST /v1.0/merchants/{merchant_code}/payments/{transaction_id}/refunds). */
  describe('SumUp.refund', () => {
    afterEach(() => vi.unstubAllGlobals());
    const TX = '410fc44a-5956-44e1-b5cc-19c6f8d727a4';
    const REFUND_URL = `https://api.sumup.com/v1.0/merchants/M123/payments/${TX}/refunds`;
    const checkout = (transactions: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ id: 'co_1', status: 'PAID', amount: 25.5, transactions, ...over });
    const successful = { id: TX, status: 'SUCCESSFUL', amount: 25.5 };

    /** Simula la API de SumUp según la ruta y apunta las llamadas que recibe. */
    function sumup(routes: { checkout?: [number, unknown]; refund?: [number, unknown] }) {
      const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
          calls.push({ url, method: init?.method ?? 'GET', body: init?.body, auth: init?.headers?.Authorization });
          const [status, body] = (url.includes('/checkouts/') ? routes.checkout : routes.refund) ?? [500, {}];
          return { ok: status >= 200 && status < 300, status, json: async () => body };
        })
      );
      return calls;
    }
    const adapter = () => new SumUpAdapter('key_1', 'M123');

    it('reembolsa la TRANSACCIÓN cobrada (no el id del checkout) por la ruta de reembolsos de SumUp y con la clave de la cuenta', async () => {
      const calls = sumup({ checkout: [200, checkout([successful])], refund: [200, {}] });
      expect(await adapter().refund('co_1', 25.5, 'refund_o1')).toEqual({ success: true, refundId: TX });
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.sumup.com/v0.1/checkouts/co_1', `POST ${REFUND_URL}`]);
      expect(calls.every((c) => c.auth === 'Bearer key_1')).toBe(true);
      expect(calls.some((c) => c.url.includes('/receipts/'))).toBe(false); // la ruta antigua, que no existe en SumUp
    });

    it('un reembolso total no manda importe (SumUp reembolsa todo lo cobrado)', async () => {
      const calls = sumup({ checkout: [200, checkout([successful])], refund: [200, {}] });
      await adapter().refund('co_1', 25.5);
      expect(JSON.parse(calls[1].body ?? 'null')).toEqual({});
    });

    it('un importe menor que lo cobrado se manda como reembolso parcial', async () => {
      const calls = sumup({ checkout: [200, checkout([successful])], refund: [200, {}] });
      await adapter().refund('co_1', 10);
      expect(JSON.parse(calls[1].body ?? 'null')).toEqual({ amount: 10 });
    });

    it('si la transacción ya consta como reembolsada se da por hecho, sin volver a llamar (un reintento no se atasca en un 409)', async () => {
      const calls = sumup({ checkout: [200, checkout([{ id: TX, status: 'REFUNDED', amount: 25.5 }])], refund: [409, { message: 'ya reembolsada' }] });
      expect(await adapter().refund('co_1', 25.5)).toEqual({ success: true, refundId: TX });
      expect(calls).toHaveLength(1);
    });

    it('sin ninguna transacción cobrada no hay nada que reembolsar: falla y no llama a la ruta de reembolsos', async () => {
      const calls = sumup({ checkout: [200, checkout([{ id: 'tx_f', status: 'FAILED', amount: 25.5 }], { status: 'FAILED' })], refund: [200, {}] });
      const r = await adapter().refund('co_1', 25.5);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/ninguna transacción cobrada/i);
      expect(calls).toHaveLength(1);
    });

    it('si no se encuentra el checkout falla con el mensaje de SumUp y no reembolsa nada', async () => {
      const calls = sumup({ checkout: [404, { message: 'Checkout not found' }], refund: [200, {}] });
      expect(await adapter().refund('co_x', 25.5)).toEqual({ success: false, error: 'Checkout not found' });
      expect(calls).toHaveLength(1);
    });

    it('si SumUp rechaza el reembolso, falla con su mensaje (el pedido volverá a su estado y el admin verá el motivo)', async () => {
      sumup({ checkout: [200, checkout([successful])], refund: [422, { message: 'INVALID_AMOUNT' }] });
      expect(await adapter().refund('co_1', 10)).toEqual({ success: false, error: 'INVALID_AMOUNT' });
    });

    it('un importe mayor que lo cobrado (o cero) ni siquiera se envía a SumUp: lo rechaza el adaptador y no sale ninguna orden de reembolso (P1-13)', async () => {
      const calls = sumup({ checkout: [200, checkout([successful])], refund: [200, {}] });
      for (const bad of [99, 0]) {
        const r = await adapter().refund('co_1', bad);
        expect(r).toMatchObject({ success: false, error: expect.stringMatching(/Importe de reembolso no válido/) });
      }
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('un fallo de red no lanza: se devuelve como fallo, igual que en Stripe', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
      expect(await adapter().refund('co_1', 25.5)).toEqual({ success: false, error: 'socket hang up' });
    });
  });
});

describe('Stripe.parseWebhook', () => {
  it('pago completado → payment_succeeded con el pedido de los metadatos', async () => {
    const body = event('checkout.session.completed', { id: 'cs_1', payment_status: 'paid', metadata: { orderId: 'ord_1' } }, 'evt_paid');
    expect(await stripe().parseWebhook!(body, headers(sign(body)))).toEqual({ kind: 'payment_succeeded', eventId: 'evt_paid', orderId: 'ord_1' });
  });

  it('el importe y la moneda que dice la pasarela viajan con el evento (para contrastarlos con el pedido antes de completarlo)', async () => {
    const body = event('checkout.session.completed', { id: 'cs_1', payment_status: 'paid', amount_total: 3349, currency: 'eur', metadata: { orderId: 'ord_1' } }, 'evt_amt');
    expect(await stripe().parseWebhook!(body, headers(sign(body)))).toEqual({ kind: 'payment_succeeded', eventId: 'evt_amt', orderId: 'ord_1', amount: 33.49, currency: 'eur' });
  });

  it('pago asíncrono confirmado también cuenta', async () => {
    const body = event('checkout.session.async_payment_succeeded', { payment_status: 'paid', metadata: { orderId: 'ord_2' } }, 'evt_async');
    expect((await stripe().parseWebhook!(body, headers(sign(body)))).kind).toBe('payment_succeeded');
  });

  it('completado pero NO pagado (p. ej. pago diferido pendiente) se ignora: nunca se marca pagado por error', async () => {
    const body = event('checkout.session.completed', { payment_status: 'unpaid', metadata: { orderId: 'ord_3' } }, 'evt_unpaid');
    expect(await stripe().parseWebhook!(body, headers(sign(body)))).toEqual({ kind: 'ignored', eventId: 'evt_unpaid' });
  });

  it.each(['checkout.session.expired', 'checkout.session.async_payment_failed'])('%s → payment_expired', async (type) => {
    const body = event(type, { metadata: { orderId: 'ord_4' } }, 'evt_exp');
    expect(await stripe().parseWebhook!(body, headers(sign(body)))).toEqual({ kind: 'payment_expired', eventId: 'evt_exp', orderId: 'ord_4' });
  });

  it('sin orderId en los metadatos, o con un tipo que no interesa, se ignora', async () => {
    const noOrder = event('checkout.session.completed', { payment_status: 'paid', metadata: {} }, 'evt_a');
    expect((await stripe().parseWebhook!(noOrder, headers(sign(noOrder)))).kind).toBe('ignored');
    const other = event('customer.created', {}, 'evt_b');
    expect(await stripe().parseWebhook!(other, headers(sign(other)))).toEqual({ kind: 'ignored', eventId: 'evt_b' });
  });

  it.each([
    ['sin cabecera de firma', (b: string) => headers(), 'Falta la cabecera stripe-signature'],
    ['con firma inválida', (b: string) => headers('t=1,v1=deadbeef'), 'Firma inválida'],
    ['firmado con OTRO secreto', (b: string) => headers(sign(b, 'whsec_de_otro_cliente')), 'Firma inválida'],
    ['con el cuerpo alterado tras firmar', (b: string) => headers(sign(b.replace('ord_1', 'ord_999'))), 'Firma inválida'],
  ])('rechaza (400) un webhook %s', async (_n, mk, message) => {
    const body = event('checkout.session.completed', { payment_status: 'paid', metadata: { orderId: 'ord_1' } });
    const rejected = await stripe().parseWebhook!(body, mk(body)).catch((e) => e);
    expect(rejected).toBeInstanceOf(WebhookRejected);
    expect(rejected).toMatchObject({ status: 400, message });
  });

  it('sin secreto del webhook (o sin clave) dice que no está configurado, no «firma inválida»', async () => {
    const body = event('checkout.session.completed', { payment_status: 'paid', metadata: { orderId: 'o' } });
    for (const adapter of [stripe(''), stripe(SECRET, '')]) {
      const rejected = await adapter.parseWebhook!(body, headers(sign(body))).catch((e) => e);
      expect(rejected).toMatchObject({ status: 400, message: 'Stripe no está configurado' });
    }
  });
});
