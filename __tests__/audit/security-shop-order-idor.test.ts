// AUDIT: IDOR sin ningún control de acceso en GET /api/shop/orders/[orderId] | Severidad: Alta
//
// A diferencia de su equivalente para entradas (GET /api/orders/[orderId], que exige
// allowOrderAccess con token firmado o sesión de staff), este endpoint devuelve el
// pedido de tienda completo (nombre, email, dirección, ciudad, CP, teléfono, artículos)
// a cualquiera que conozca o adivine el orderId, sin sesión ni token.
//
// Este test debe FALLAR mientras el bug esté presente (hoy: 200 + datos completos) y
// PASAR una vez se exija autorización equivalente a la de /api/orders/[orderId]
// (token firmado tipo signShopOrderAccess, o sesión ADMIN/TAQUILLA).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as getShopOrder } from '@/app/api/shop/orders/[orderId]/route';

describe('AUDIT — GET /api/shop/orders/[orderId] requiere autorización', () => {
  let orderId: string;
  let productId: string;

  beforeAll(async () => {
    const suffix = `audit-idor-${Date.now()}`;
    const product = await prisma.product.create({
      data: {
        name: `[TEST] Producto ${suffix}`,
        slug: `test-producto-${suffix}`,
        price: 15,
        sizes: 'M',
        colors: 'Negro',
        isActive: true,
      },
    });
    productId = product.id;

    const order = await prisma.shopOrder.create({
      data: {
        buyerName: '[TEST] Víctima IDOR',
        buyerEmail: 'victima-idor@example.com',
        shippingAddress: 'Calle Secreta 42',
        shippingCity: 'Madrid',
        shippingZip: '28001',
        shippingPhone: '600111222',
        totalAmount: 15,
        status: 'PAID',
        items: {
          create: [{ productId, quantity: 1, unitPrice: 15, size: 'M', color: 'Negro' }],
        },
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await prisma.shopOrderItem.deleteMany({ where: { productId } });
    await prisma.shopOrder.delete({ where: { id: orderId } }).catch(() => {});
    await prisma.product.delete({ where: { id: productId } }).catch(() => {});
  });

  it('no debe devolver datos del comprador sin token ni sesión', async () => {
    const res = await getShopOrder(new Request(`http://localhost/api/shop/orders/${orderId}`), {
      params: { orderId },
    });

    // Comportamiento esperado tras el fix: 401, igual que /api/orders/[orderId] sin token.
    expect(res.status).toBe(401);
  });
});
