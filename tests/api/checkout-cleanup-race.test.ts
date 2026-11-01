import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { POST as createShopOrder } from '@/app/api/shop/orders/route';
import { releaseExpiredOrder } from '@/lib/reconciliation/entradas';
import { releaseExpiredShopOrder } from '@/lib/reconciliation/tienda';
import { syncProductVariants } from '@/lib/product-stock';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';

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

/* H-037: si la pasarela no podía abrir la sesión de pago, la limpieza hacía `update` a CANCELLED SIN condición y liberaba el stock otra vez aunque otro camino
 * (el comprador volviendo atrás, el cron de caducidad) ya hubiera anulado el pedido: `soldCount` inflado a la baja / stock repuesto de más, es decir, sobreventa.
 * Ahora la limpieza es la misma anulación con compare-and-swap que usan esos caminos: solo libera quien de verdad pasó el pedido de PENDING a CANCELLED. */

const post = (handler: (r: Request) => Promise<Response>, body: unknown, ip: string) =>
  handler(new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ acceptedTerms: true, ...(body as object) }) }));

describe('limpieza tras fallar la sesión de pago (H-037)', () => {
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
    await prisma.shopOrderItem.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
    await prisma.pendingSlot.deleteMany({});
  });
  beforeEach(() => {
    gateway.reset();
    gateway.active = true;
    gateway.failCreate = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('entradas: si otro camino ya anuló el pedido mientras fallaba la pasarela, el aforo se libera UNA vez', async () => {
    const before = (await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).soldCount;
    gateway.beforeCreate = async ({ orderId }) => {
      await releaseExpiredOrder(orderId); // el comprador volvió atrás / caducó la reserva en esa ventana
    };
    const res = await post(createOrder, { eventId: event.id, buyerName: 'Ana', buyerLastName: 'Gil', buyerEmail: 'race-ent@example.com', items: [{ ticketTypeId: tt.id, quantity: 2 }] }, freshIp());
    expect(res.status).toBe(502);
    expect((await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).soldCount).toBe(before);
  });

  it('entradas: sin carrera, el fallo sigue liberando el aforo y anulando las entradas (502)', async () => {
    const before = (await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).soldCount;
    const res = await post(createOrder, { eventId: event.id, buyerName: 'Ana', buyerLastName: 'Gil', buyerEmail: 'plain-ent@example.com', items: [{ ticketTypeId: tt.id, quantity: 2 }] }, freshIp());
    expect(res.status).toBe(502);
    expect((await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).soldCount).toBe(before);
    const orders = await prisma.order.findMany({ where: { buyerEmail: 'plain-ent@example.com' }, include: { tickets: true } });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('CANCELLED');
    expect(orders[0].tickets.every((t) => t.status === 'CANCELLED')).toBe(true);
  });

  async function product() {
    const suffix = `cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const p = await prisma.product.create({ data: { name: `[TEST] Gorra ${suffix}`, slug: `test-gorra-${suffix}`, price: 20, sizes: 'M', colors: 'Negro', isActive: true } });
    productIds.push(p.id);
    await prisma.$transaction(async (tx) => {
      await syncProductVariants(tx, p.id, p.sizes, p.colors, [{ size: 'M', color: 'Negro', stock: 5 }]);
    });
    return p.id;
  }
  const shopBody = (productId: string, email: string) => ({
    buyerName: 'Luis', buyerEmail: email, shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001', items: [{ productId, quantity: 1, size: 'M', color: 'Negro' }],
  });
  const stock = async (productId: string) => (await prisma.productVariant.findFirstOrThrow({ where: { productId } })).stock;

  it('tienda: si otro camino ya anuló el pedido mientras fallaba la pasarela, el stock se repone UNA vez (no queda stock fantasma)', async () => {
    const productId = await product();
    gateway.beforeCreate = async ({ orderId }) => {
      await releaseExpiredShopOrder(orderId);
    };
    const res = await post(createShopOrder, shopBody(productId, 'race-shop@example.com'), freshIp());
    expect(res.status).toBe(502);
    expect(await stock(productId)).toBe(5);
  });

  it('tienda: sin carrera, el fallo repone el stock y deja el pedido CANCELLED', async () => {
    const productId = await product();
    const res = await post(createShopOrder, shopBody(productId, 'plain-shop@example.com'), freshIp());
    expect(res.status).toBe(502);
    expect(await stock(productId)).toBe(5);
    expect((await prisma.shopOrder.findFirstOrThrow({ where: { buyerEmail: 'plain-shop@example.com' } })).status).toBe('CANCELLED');
  });
});
