// AUDIT: PUT /api/admin/shop-orders/[id] no tiene ninguna lógica de negocio asociada al
// cambio de estado — marcar un ShopOrder como REFUNDED/CANCELLED es un simple UPDATE de
// la columna `status`: no se llama a la pasarela de pago (el dinero no se devuelve) ni
// se libera el stock reservado en ProductVariant (el inventario queda "vendido" para
// siempre). No existe ningún equivalente de invalidateOrder() para ShopOrder.
// Severidad: Alta.
//
// Este test cubre la parte verificable sin mockear la pasarela de pago: la liberación
// de stock. Debe FALLAR mientras el bug esté presente (hoy: el stock no se restaura) y
// PASAR una vez el PUT (o una función invalidateShopOrder análoga) libere el stock de
// las variantes al pasar a REFUNDED/CANCELLED un pedido que ya estaba PAID.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { syncProductVariants } from '@/lib/product-stock';

const adminEmail = `admin-audit-shoprefund-${Date.now()}@test.local`;
let adminUserId: string;

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: adminUserId, role: 'ADMIN', email: adminEmail },
  })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { PUT: updateShopOrder } = await import('@/app/api/admin/shop-orders/[id]/route');

function putRequest(body: unknown) {
  return new Request('http://localhost/api/admin/shop-orders/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('AUDIT — reembolsar un ShopOrder debe liberar el stock reservado', () => {
  let productId: string;
  let orderId: string;

  beforeAll(async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const user = await prisma.user.create({
      data: { email: adminEmail, name: 'Admin Audit', hashedPassword: await bcrypt.hash('x', 4), role: 'ADMIN' },
    });
    adminUserId = user.id;

    const suffix = `audit-shoprefund-${Date.now()}`;
    const product = await prisma.product.create({
      data: { name: `[TEST] Sudadera ${suffix}`, slug: `test-sudadera-${suffix}`, price: 30, sizes: 'M', colors: 'Negro', isActive: true },
    });
    productId = product.id;
    await prisma.$transaction(async (tx) => {
      await syncProductVariants(tx, product.id, product.sizes, product.colors, [{ size: 'M', color: 'Negro', stock: 5 }]);
    });
    // Simula una compra ya pagada: el stock ya se descontó a 4.
    await prisma.productVariant.updateMany({ where: { productId, size: 'M', color: 'Negro' }, data: { stock: 4 } });

    const order = await prisma.shopOrder.create({
      data: {
        buyerName: '[TEST] Comprador tienda',
        buyerEmail: 'shop-refund-audit@example.com',
        shippingAddress: 'x',
        shippingCity: 'y',
        shippingZip: '28001',
        totalAmount: 30,
        status: 'PAID',
        items: { create: [{ productId, quantity: 1, unitPrice: 30, size: 'M', color: 'Negro' }] },
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await prisma.shopOrderItem.deleteMany({ where: { productId } });
    await prisma.shopOrder.delete({ where: { id: orderId } }).catch(() => {});
    await prisma.product.delete({ where: { id: productId } }).catch(() => {});
    await prisma.user.delete({ where: { id: adminUserId } }).catch(() => {});
  });

  it('restaura el stock de la variante al marcar el pedido como REFUNDED', async () => {
    const res = await updateShopOrder(putRequest({ status: 'REFUNDED' }), { params: { id: orderId } });
    expect(res.status).toBe(200);

    const variant = await prisma.productVariant.findUnique({
      where: { productId_size_color: { productId, size: 'M', color: 'Negro' } },
    });
    // Comportamiento esperado tras el fix: el stock vuelve a 5 (se libera la unidad).
    expect(variant?.stock).toBe(5);
  });
});
