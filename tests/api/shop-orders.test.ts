import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createShopOrder } from '@/app/api/shop/orders/route';
import { getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { syncProductVariants } from '@/lib/product-stock';
import { releaseExpiredShopOrder } from '@/lib/order-reconciliation';

function shopRequest(body: unknown, ip: string) {
  return new Request('http://localhost/api/shop/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('POST /api/shop/orders — stock', () => {
  let originalGateway: string | null;
  let productId: string;

  beforeAll(async () => {
    originalGateway = await getAndSetConfig('payment_gateway', 'mock');
  });

  afterAll(async () => {
    await restoreConfig('payment_gateway', originalGateway);
  });

  beforeEach(async () => {
    const suffix = `shop-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const product = await prisma.product.create({
      data: {
        name: `[TEST] Camiseta ${suffix}`,
        slug: `test-camiseta-${suffix}`,
        price: 20,
        sizes: 'M,L',
        colors: 'Negro',
        isActive: true,
      },
    });
    productId = product.id;
    await prisma.$transaction(async (tx) => {
      await syncProductVariants(tx, product.id, product.sizes, product.colors, [
        { size: 'M', color: 'Negro', stock: 2 },
        { size: 'L', color: 'Negro', stock: 0 },
      ]);
    });
  });

  afterEach(async () => {
    if (!productId) return;
    await prisma.shopOrderItem.deleteMany({ where: { productId } });
    await prisma.shopOrder.deleteMany({
      where: { items: { some: { productId } } },
    });
    await prisma.product.delete({ where: { id: productId } }).catch(() => {});
  });

  it('reserva stock y completa el pedido mock', async () => {
    const res = await createShopOrder(
      shopRequest(
        {
          buyerName: 'Luis',
          buyerEmail: 'luis-shop@example.com',
          shippingAddress: 'Calle Test 1',
          shippingCity: 'Madrid',
          shippingZip: '28001',
          items: [{ productId, quantity: 1, size: 'M', color: 'Negro' }],
        },
        '198.51.100.1'
      )
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    const variant = await prisma.productVariant.findUnique({
      where: { productId_size_color: { productId, size: 'M', color: 'Negro' } },
    });
    expect(variant?.stock).toBe(1);

    const order = await prisma.shopOrder.findUnique({ where: { id: json.orderId } });
    expect(order?.status).toBe('PAID');
  });

  it('rechaza si no hay stock', async () => {
    const res = await createShopOrder(
      shopRequest(
        {
          buyerName: 'Luis',
          buyerEmail: 'luis-shop2@example.com',
          shippingAddress: 'Calle Test 1',
          shippingCity: 'Madrid',
          shippingZip: '28001',
          items: [{ productId, quantity: 1, size: 'L', color: 'Negro' }],
        },
        '198.51.100.2'
      )
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/stock/i);
  });

  it('devuelve stock al cancelar un PENDING abandonado', async () => {
    await prisma.productVariant.updateMany({
      where: { productId, size: 'M', color: 'Negro' },
      data: { stock: { decrement: 1 } },
    });
    const order = await prisma.shopOrder.create({
      data: {
        buyerName: 'Abandono',
        buyerEmail: 'abandono@example.com',
        shippingAddress: 'x',
        shippingCity: 'y',
        shippingZip: '28001',
        totalAmount: 20,
        status: 'PENDING',
        items: {
          create: [{ productId, quantity: 1, unitPrice: 20, size: 'M', color: 'Negro' }],
        },
      },
    });

    await releaseExpiredShopOrder(order.id);

    const updated = await prisma.shopOrder.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe('CANCELLED');

    const variant = await prisma.productVariant.findUnique({
      where: { productId_size_color: { productId, size: 'M', color: 'Negro' } },
    });
    expect(variant?.stock).toBe(2);
  });
});
