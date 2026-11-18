import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { cleanupWarn } from '../helpers/fixtures';
import { prisma } from '@/lib/prisma';
import { syncProductVariants } from '@/lib/product-stock';

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'admin-shop-states', role: 'ADMIN' } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { PUT: putShopOrder } = await import('@/app/api/admin/shop-orders/[id]/route');

type Status = 'PENDING' | 'PAID' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';

// AUDIT: el admin podía poner cualquier estado a un pedido (PENDING→SHIPPED sin cobro, PAID→PENDING, resucitar un pedido anulado) y
// reembolsar un pedido ya enviado devolvía el stock aunque la mercancía no volviera. Severidad: Alto (estado y stock falsos).
describe('Pedidos de tienda — transiciones de estado y stock en reembolsos', () => {
  let productId: string;
  const orderIds: string[] = [];

  beforeAll(async () => {
    const product = await prisma.product.create({ data: { name: '[TEST] Estados', slug: `test-estados-${Date.now()}`, price: 20, sizes: 'M', colors: 'Negro', isActive: true } });
    productId = product.id;
    await prisma.$transaction((tx) => syncProductVariants(tx, product.id, product.sizes, product.colors, [{ size: 'M', color: 'Negro', stock: 5 }]));
  });

  afterAll(async () => {
    await prisma.shopOrderItem.deleteMany({ where: { productId } });
    await prisma.shopOrder.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.product.delete({ where: { id: productId } }).catch(cleanupWarn);
  });

  async function order(status: Status) {
    const o = await prisma.shopOrder.create({
      data: {
        buyerName: 'Luis', buyerEmail: 'estados@example.com', shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001',
        totalAmount: 40, status, paymentProvider: 'mock',
        items: { create: [{ productId, quantity: 2, unitPrice: 20, size: 'M', color: 'Negro' }] },
      },
    });
    orderIds.push(o.id);
    return o;
  }
  const put = (id: string, body: unknown) => putShopOrder(new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const stock = async () => (await prisma.productVariant.findFirst({ where: { productId, size: 'M', color: 'Negro' } }))?.stock;
  const statusOf = async (id: string) => (await prisma.shopOrder.findUnique({ where: { id } }))?.status;

  it('un pedido sin pagar solo puede pasar a PAID: no a enviado ni entregado', async () => {
    const o = await order('PENDING');
    for (const to of ['PROCESSING', 'SHIPPED', 'DELIVERED'] as const) {
      expect((await put(o.id, { status: to })).status, to).toBe(422);
    }
    expect(await statusOf(o.id)).toBe('PENDING');
    expect((await put(o.id, { status: 'PAID' })).status).toBe(200);
  });

  it('un pedido ya pagado no puede volver a PENDING', async () => {
    const o = await order('PAID');
    expect((await put(o.id, { status: 'PENDING' })).status).toBe(422);
    expect(await statusOf(o.id)).toBe('PAID');
  });

  it('entre los estados de después del pago se puede avanzar y corregir', async () => {
    const o = await order('PAID');
    expect((await put(o.id, { status: 'SHIPPED' })).status).toBe(200);
    expect((await put(o.id, { status: 'PROCESSING' })).status).toBe(200);
    expect((await put(o.id, { status: 'DELIVERED' })).status).toBe(200);
  });

  it('un pedido anulado o reembolsado no cambia de estado, pero sí admite notas', async () => {
    for (const s of ['CANCELLED', 'REFUNDED'] as const) {
      const o = await order(s);
      expect((await put(o.id, { status: 'PAID' })).status, s).toBe(422);
      expect((await put(o.id, { notes: 'Nota interna' })).status, s).toBe(200);
      expect(await statusOf(o.id)).toBe(s);
    }
  });

  // H-187: la transición se validaba con el estado leído al principio y el `update` era incondicional: un reembolso que llegaba entre la lectura y la escritura se pisaba
  // (el pedido reembolsado pasaba a «Enviado» y el rastro decía que se había enviado).
  it('H-187: un cambio de estado concurrente (reembolso entre la lectura y la escritura) no se pisa: 409 y el pedido sigue REFUNDED', async () => {
    const o = await order('PAID');
    const real = (globalThis as unknown as { prisma: typeof prisma }).prisma;
    const original = real.shopOrder.findUnique.bind(real.shopOrder) as (...a: unknown[]) => Promise<unknown>;
    let flipped = false;
    const spy = vi.spyOn(real.shopOrder, 'findUnique').mockImplementation(((...a: unknown[]) => {
      const args = a[0] as { select?: { trackingNumber?: boolean } } | undefined;
      if (!flipped && args?.select?.trackingNumber) {
        flipped = true;
        return original(...a).then(async (row) => {
          await prisma.shopOrder.update({ where: { id: o.id }, data: { status: 'REFUNDED' } });
          return row;
        });
      }
      return original(...a);
    }) as never);
    try {
      expect((await put(o.id, { status: 'SHIPPED' })).status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect(await statusOf(o.id)).toBe('REFUNDED');
  });

  it('repetir el mismo estado (p. ej. al guardar solo el seguimiento) funciona', async () => {
    const o = await order('SHIPPED');
    expect((await put(o.id, { status: 'SHIPPED', trackingNumber: 'ES123' })).status).toBe(200);
  });

  it('reembolsar un pedido PAGADO (sin enviar) devuelve el stock', async () => {
    const o = await order('PAID');
    const before = await stock();
    expect((await put(o.id, { status: 'REFUNDED' })).status).toBe(200);
    expect(await stock()).toBe((before ?? 0) + 2);
  });

  it('reembolsar un pedido ya ENVIADO o ENTREGADO NO devuelve el stock', async () => {
    for (const s of ['SHIPPED', 'DELIVERED'] as const) {
      const o = await order(s);
      const before = await stock();
      expect((await put(o.id, { status: 'REFUNDED' })).status, s).toBe(200);
      expect(await stock(), s).toBe(before);
    }
  });
});
