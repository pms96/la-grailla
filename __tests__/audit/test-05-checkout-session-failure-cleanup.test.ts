// AUDIT: TEST-05 — la limpieza al fallar la creación de la sesión de checkout
// (createCheckoutSession) en POST /api/orders y POST /api/shop/orders solo se
// había probado indirectamente (o no se había probado nunca de forma
// automatizada): un fallo de red/timeout real hacia Stripe/SumUp en el momento
// de crear el pedido no tenía ningún test que demostrara que las entradas/el
// stock reservado se liberan y el pedido queda CANCELLED en vez de huérfano en
// PENDING.
//
// Se mockea el paquete `stripe` para que checkout.sessions.create lance (como un
// timeout de red real) y se comprueba el rollback completo en ambos endpoints.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { POST as createShopOrder } from '@/app/api/shop/orders/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../../tests/helpers/fixtures';
import { syncProductVariants } from '@/lib/product-stock';

const sessionsCreate = vi.fn(async () => {
  throw new Error('ETIMEDOUT: fetch failed');
});

vi.mock('stripe', () => ({
  default: class MockStripe {
    checkout = { sessions: { create: sessionsCreate } };
  },
}));

function orderRequest(url: string, body: unknown, ip: string) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('AUDIT — fallo de la pasarela al crear la sesión de checkout limpia el pedido', () => {
  let originalGateway: string | null;
  let originalSecretKey: string | null;

  beforeAll(async () => {
    originalGateway = await getAndSetConfig('payment_gateway', 'stripe');
    originalSecretKey = await getAndSetConfig('stripe_secret_key', 'sk_test_fake_for_test05');
  });

  afterAll(async () => {
    await restoreConfig('payment_gateway', originalGateway);
    await restoreConfig('stripe_secret_key', originalSecretKey);
  });

  it('POST /api/orders: cancela el pedido, libera stock y limpia idempotencyKey', async () => {
    const event = await createTestEvent();
    const ticketType = await createTicketType(event.id, { maxQuantity: 5, price: 15 });
    const idempotencyKey = `test05-orders-${Date.now()}`;

    try {
      const res = await createOrder(
        orderRequest(
          'http://localhost/api/orders',
          {
            eventId: event.id,
            buyerName: 'Test',
            buyerLastName: 'Test05',
            buyerEmail: 'test05-orders@example.com',
            items: [{ ticketTypeId: ticketType.id, quantity: 2 }],
            idempotencyKey,
          },
          '203.0.113.50'
        )
      );

      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toMatch(/no se ha podido iniciar el pago/i);

      const order = await prisma.order.findFirst({ where: { idempotencyKey: null, buyerEmail: 'test05-orders@example.com' }, include: { tickets: true } });
      expect(order).not.toBeNull();
      expect(order?.status).toBe('CANCELLED');
      expect(order?.idempotencyKey).toBeNull();
      expect(order?.tickets.every((t) => t.status === 'CANCELLED')).toBe(true);

      const updatedTicketType = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
      expect(updatedTicketType?.soldCount).toBe(0);

      // Un reintento con la misma clave debe poder generar un pedido nuevo de
      // verdad, no reencontrar el cancelado como si fuera un éxito.
      const retryFinder = await prisma.order.findUnique({ where: { idempotencyKey } });
      expect(retryFinder).toBeNull();
    } finally {
      await cleanupTestEvent(event.id);
    }
  });

  it('POST /api/shop/orders: cancela el pedido y libera el stock reservado', async () => {
    const suffix = `test05-shop-${Date.now()}`;
    const product = await prisma.product.create({
      data: {
        name: `[TEST] ${suffix}`,
        slug: suffix,
        price: 20,
        sizes: 'M',
        colors: 'Negro',
        isActive: true,
      },
    });
    await prisma.$transaction(async (tx) => {
      await syncProductVariants(tx, product.id, product.sizes, product.colors, [
        { size: 'M', color: 'Negro', stock: 3 },
      ]);
    });

    try {
      const res = await createShopOrder(
        orderRequest(
          'http://localhost/api/shop/orders',
          {
            buyerName: 'Test',
            buyerEmail: 'test05-shop@example.com',
            shippingAddress: 'Calle Test 1',
            shippingCity: 'Madrid',
            shippingZip: '28001',
            items: [{ productId: product.id, quantity: 2, size: 'M', color: 'Negro' }],
          },
          '203.0.113.51'
        )
      );

      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/no se ha podido iniciar el pago/i);

      const order = await prisma.shopOrder.findFirst({ where: { buyerEmail: 'test05-shop@example.com' } });
      expect(order).not.toBeNull();
      expect(order?.status).toBe('CANCELLED');

      const variant = await prisma.productVariant.findUnique({
        where: { productId_size_color: { productId: product.id, size: 'M', color: 'Negro' } },
      });
      expect(variant?.stock).toBe(3);
    } finally {
      await prisma.shopOrderItem.deleteMany({ where: { productId: product.id } });
      await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: product.id } } } });
      await prisma.product.delete({ where: { id: product.id } }).catch(() => {});
    }
  });
});
