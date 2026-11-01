import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { StripeAdapter, SumUpAdapter } from '@/lib/payment-adapter';

/* H-155 (P1-07): `amounts.test.ts` calcula `Math.round(amount*100)` en el propio test y sustituye toda la pasarela por una falsa, así que la conversión REAL
 * euros → céntimos del adaptador de Stripe (`unit_amount: toCents(...)`) no la probaba nadie: volver a `Math.floor(amount * 100)` o a `amount * 100` dejaba la suite
 * en verde y cobraba un céntimo de menos (33,50 € → 3349) o un decimal inválido. Aquí se mira lo que el SDK recibe de verdad. Sin red: el SDK y el fetch están simulados. */

const stripeMock = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), refundCreate: vi.fn() }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    checkout = { sessions: { create: stripeMock.create, retrieve: stripeMock.retrieve } };
    refunds = { create: stripeMock.refundCreate };
  },
}));

const base = { currency: 'eur', description: 'Entradas', orderId: 'ord_1', successUrl: 'https://x/ok', cancelUrl: 'https://x/ko', customerEmail: 'a@b.c' };

beforeEach(() => {
  for (const fn of Object.values(stripeMock)) fn.mockReset();
  stripeMock.create.mockResolvedValue({ id: 'cs_1', url: 'https://pay' });
});
afterEach(() => vi.unstubAllGlobals());

// Importes que la coma flotante no representa exactamente: `amount * 100` da 114.99999999999999, 1409.9999999999998…, y `Math.floor` se comería un céntimo.
const CASES: [number, number][] = [
  [33.5, 3350],
  [16.5, 1650],
  [0.07, 7],
  [1.15, 115],
  [4.35, 435],
  [14.1, 1410],
  [19.99, 1999],
  [0.1 + 0.2, 30],
  [1234.56, 123456],
  [0.01, 1],
  [8.2, 820],
  [57.38, 5738],
];

describe('Stripe createCheckoutSession: el importe que recibe el SDK son céntimos ENTEROS exactos', () => {
  it.each(CASES)('%s € → unit_amount %i', async (euros, cents) => {
    await new StripeAdapter('sk_test_fake').createCheckoutSession({ ...base, amount: euros });
    const sent = stripeMock.create.mock.calls[0][0];
    const item = sent.line_items[0];
    expect(item.price_data.unit_amount).toBe(cents);
    expect(Number.isInteger(item.price_data.unit_amount)).toBe(true);
    expect(item.quantity).toBe(1); // el total va en UNA línea: si la cantidad fuera otra, se cobraría multiplicado
    expect(item.price_data.currency).toBe('eur');
  });

  it('manda la clave de idempotencia del pedido (un reintento no crea una segunda sesión)', async () => {
    await new StripeAdapter('sk_test_fake').createCheckoutSession({ ...base, amount: 10 });
    expect(stripeMock.create.mock.calls[0][1]).toEqual({ idempotencyKey: 'checkout_ord_1' });
  });
});

describe('Stripe refund: el reembolso parcial también va en céntimos exactos; sin importe, es total', () => {
  beforeEach(() => stripeMock.retrieve.mockResolvedValue({ id: 'cs_1', payment_intent: 'pi_1' }));

  it.each(CASES)('reembolsar %s € → amount %i', async (euros, cents) => {
    stripeMock.refundCreate.mockResolvedValue({ id: 're_1' });
    expect(await new StripeAdapter('sk').refund('cs_1', euros)).toEqual({ success: true, refundId: 're_1' });
    expect(stripeMock.refundCreate.mock.calls[0][0]).toEqual({ payment_intent: 'pi_1', amount: cents });
  });

  it('sin importe no se manda `amount` (Stripe reembolsa todo lo cobrado)', async () => {
    stripeMock.refundCreate.mockResolvedValue({ id: 're_1' });
    await new StripeAdapter('sk').refund('cs_1');
    expect(stripeMock.refundCreate.mock.calls[0][0]).toEqual({ payment_intent: 'pi_1' });
  });
});

describe('Stripe verifyPayment: lo cobrado vuelve a euros sin pérdida', () => {
  it.each(CASES)('amount_total %i céntimos → %s €', async (euros, cents) => {
    stripeMock.retrieve.mockResolvedValue({ id: 'cs_1', status: 'complete', payment_status: 'paid', amount_total: cents, currency: 'eur' });
    const r = await new StripeAdapter('sk').verifyPayment('cs_1');
    expect(r).toMatchObject({ status: 'PAID', amount: Math.round(euros * 100) / 100 });
  });
});

describe('SumUp createCheckoutSession: el importe va en euros con 2 decimales exactos (no en céntimos)', () => {
  it.each(CASES)('%s € → amount %s', async (euros, cents) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'co_1', hosted_checkout_url: 'https://pay' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new SumUpAdapter('key', 'M1').createCheckoutSession({ ...base, amount: euros });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.amount).toBe(cents / 100);
    expect(body.currency).toBe('EUR');
  });
});
