import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { POST as createShopOrder } from '@/app/api/shop/orders/route';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/observability/capture', async (orig) => ({ ...(await orig<typeof import('@/lib/observability/capture')>()), captureOpsError: capture }));
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return {
    ...actual,
    getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)),
    getPaymentProvider: async (s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProvider(s)),
  };
});
vi.mock('@/lib/mailer', async (orig) => ({ ...(await orig<typeof import('@/lib/mailer')>()), sendMail: async () => ({ success: true, transport: 'smtp' as const }) }));

/* P0-07: que la pasarela no pueda abrir la sesión de cobro (clave caducada, caída) es un 502 en el checkout: ventas perdidas que hasta ahora solo
 * dejaban un `console.error`. Ahora avisan a Sentry con el contexto mínimo (ruta, tipo, proveedor, pedido truncado), sin datos del comprador. */

const post = (handler: (r: Request) => Promise<Response>, body: unknown, ip: string) =>
  handler(new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ acceptedTerms: true, ...(body as object) }) }));

describe('fallo de la pasarela en el checkout → Sentry', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const productIds: string[] = [];
  const runId = Math.floor(Math.random() * 60_000);
  let n = 0;
  const freshIp = () => `10.${runId >> 8}.${runId & 255}.${(n += 1)}`;

  beforeAll(async () => {
    event = await createTestEvent({ maxCapacity: 100 });
    tt = await createTicketType(event.id, { maxQuantity: 100 });
  });
  afterAll(async () => {
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'pending:' } } });
  });
  beforeEach(() => {
    gateway.reset();
    gateway.active = true;
    gateway.failCreate = true;
    capture.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('entradas: 502 al comprador y aviso con ruta, tipo, motivo y el pedido truncado; nada del comprador', async () => {
    const res = await post(createOrder, { eventId: event.id, buyerName: 'Ana', buyerLastName: 'López', buyerEmail: 'ana-sentry@example.com', items: [{ ticketTypeId: tt.id, quantity: 1 }] }, freshIp());
    expect(res.status).toBe(502);
    expect(capture).toHaveBeenCalledTimes(1);
    const [error, ctx] = capture.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({ route: 'POST /api/orders', kind: 'entradas', reason: 'checkout_session_failed' });
    expect(typeof ctx.orderId).toBe('string');
    expect(JSON.stringify(ctx)).not.toMatch(/Ana|López|ana-sentry|@/);
  });

  it('tienda: igual, con el tipo `tienda`', async () => {
    const p = await prisma.product.create({ data: { name: 'Sentry', slug: `sentry-${Date.now()}-${Math.random()}`, price: 10, variants: { create: { size: 'M', color: '', stock: 10 } } } });
    productIds.push(p.id);
    const res = await post(
      createShopOrder,
      { buyerName: 'Luis', buyerEmail: 'luis-sentry@example.com', shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001', items: [{ productId: p.id, quantity: 1, size: 'M', color: '' }] },
      freshIp()
    );
    expect(res.status).toBe(502);
    expect(capture).toHaveBeenCalledTimes(1);
    const [, ctx] = capture.mock.calls[0];
    expect(ctx).toMatchObject({ route: 'POST /api/shop/orders', kind: 'tienda', reason: 'checkout_session_failed' });
    expect(JSON.stringify(ctx)).not.toMatch(/Luis|luis-sentry|Calle|28001|@/);
  });
});
