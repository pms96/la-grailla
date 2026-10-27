import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripeAdapter, SumUpAdapter } from '@/lib/payment-adapter';

/* OB-11: listado de cobros pagados (Stripe) y búsqueda por referencia (SumUp) para la conciliación inversa. Sin red. */

const stripeMock = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    checkout = { sessions: { list: stripeMock.list } };
  },
}));

const T = Math.floor(Date.UTC(2026, 9, 26, 12) / 1000);
const sess = (id: string, over: Record<string, unknown> = {}) => ({
  id, payment_status: 'paid', amount_total: 1250, currency: 'eur', created: T, metadata: { orderId: `ord_${id}`, orderType: 'ticket' }, payment_intent: null, ...over,
});
const range = { from: new Date((T - 3600) * 1000), to: new Date((T + 3600) * 1000), deadline: Date.now() + 60_000 };

beforeEach(() => stripeMock.list.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe('StripeAdapter.listRecentPaid', () => {
  const stripe = () => new StripeAdapter('sk_test_fake');

  it('pide el intervalo en segundos, con el cargo expandido, y devuelve solo las pagadas normalizadas', async () => {
    stripeMock.list.mockResolvedValue({ has_more: false, data: [sess('cs_1'), sess('cs_2', { payment_status: 'unpaid' }), sess('cs_3', { metadata: {} })] });
    const r = await stripe().listRecentPaid({ ...range, maxPages: 5 });
    expect(stripeMock.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, status: 'complete', created: { gte: T - 3600, lte: T + 3600 }, expand: ['data.payment_intent.latest_charge'] }));
    expect(r.truncated).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.sessions).toEqual([
      { id: 'cs_1', orderId: 'ord_cs_1', orderType: 'ticket', amount: 12.5, currency: 'EUR', createdAt: new Date(T * 1000), refunded: false },
      { id: 'cs_3', orderId: null, orderType: null, amount: 12.5, currency: 'EUR', createdAt: new Date(T * 1000), refunded: false },
    ]);
  });

  it('pagina con starting_after hasta que no hay más', async () => {
    stripeMock.list
      .mockResolvedValueOnce({ has_more: true, data: [sess('cs_1'), sess('cs_2')] })
      .mockResolvedValueOnce({ has_more: false, data: [sess('cs_3')] });
    const r = await stripe().listRecentPaid({ ...range, maxPages: 5 });
    expect(r.sessions.map((s) => s.id)).toEqual(['cs_1', 'cs_2', 'cs_3']);
    expect(stripeMock.list.mock.calls[1][0]).toMatchObject({ starting_after: 'cs_2' });
  });

  it('el tope de páginas corta y lo dice (`truncated`), sin fingir que lo vio todo', async () => {
    stripeMock.list.mockResolvedValue({ has_more: true, data: [sess('cs_1')] });
    const r = await stripe().listRecentPaid({ ...range, maxPages: 2 });
    expect(stripeMock.list).toHaveBeenCalledTimes(2);
    expect(r.truncated).toBe(true);
  });

  it('pasado el plazo de tiempo corta antes de pedir otra página', async () => {
    stripeMock.list.mockResolvedValue({ has_more: true, data: [sess('cs_1')] });
    const r = await stripe().listRecentPaid({ ...range, maxPages: 5, deadline: Date.now() - 1 });
    expect(stripeMock.list).not.toHaveBeenCalled();
    expect(r.truncated).toBe(true);
  });

  it('un cargo reembolsado (total o parcial) se marca refunded', async () => {
    const charged = (c: object) => ({ payment_intent: { latest_charge: c } });
    stripeMock.list.mockResolvedValue({ has_more: false, data: [sess('cs_full', charged({ refunded: true, amount_refunded: 1250 })), sess('cs_part', charged({ refunded: false, amount_refunded: 300 })), sess('cs_none', charged({ refunded: false, amount_refunded: 0 }))] });
    const r = await stripe().listRecentPaid({ ...range, maxPages: 5 });
    expect(r.sessions.map((s) => [s.id, s.refunded])).toEqual([['cs_full', true], ['cs_part', true], ['cs_none', false]]);
  });

  it('un fallo de la API (clave inválida, red) NO lanza: devuelve el error y lo leído hasta entonces', async () => {
    stripeMock.list.mockResolvedValueOnce({ has_more: true, data: [sess('cs_1')] }).mockRejectedValueOnce(new Error('Invalid API Key provided'));
    const r = await stripe().listRecentPaid({ ...range, maxPages: 5 });
    expect(r.error).toMatch(/Invalid API Key/);
    expect(r.sessions.map((s) => s.id)).toEqual(['cs_1']);
  });
});

describe('SumUpAdapter.findPaidByReference', () => {
  const sumup = () => new SumUpAdapter('key', 'MTEST');
  const respond = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('busca por checkout_reference (codificada) con la clave de la cuenta', async () => {
    respond(200, []);
    await sumup().findPaidByReference('ord/1 x');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://api.sumup.com/v0.1/checkouts?checkout_reference=ord%2F1%20x');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer key' });
  });

  it('un checkout PAID = pagado; con una transacción REFUNDED, reembolsado; sin ninguno PAID, no pagado', async () => {
    respond(200, [{ id: 'co_1', status: 'EXPIRED' }, { id: 'co_2', status: 'PAID', transactions: [{ status: 'SUCCESSFUL' }] }]);
    expect(await sumup().findPaidByReference('o')).toEqual({ paid: true, checkoutId: 'co_2', refunded: false });
    respond(200, [{ id: 'co_3', status: 'PAID', transactions: [{ status: 'REFUNDED' }] }]);
    expect(await sumup().findPaidByReference('o')).toEqual({ paid: true, checkoutId: 'co_3', refunded: true });
    respond(200, [{ id: 'co_4', status: 'PENDING' }]);
    expect(await sumup().findPaidByReference('o')).toEqual({ paid: false, refunded: false });
  });

  it('HTTP no OK o red caída: error explícito (nunca «no pagado» a secas) y no lanza', async () => {
    respond(401, { message: 'Unauthorized' });
    expect(await sumup().findPaidByReference('o')).toMatchObject({ paid: false, error: 'Unauthorized' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await sumup().findPaidByReference('o')).toMatchObject({ paid: false, error: 'ECONNRESET' });
  });
});
