import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as getOrder } from '@/app/api/orders/[orderId]/route';
import { GET as getShopOrder } from '@/app/api/shop/orders/[orderId]/route';
import { signOrderAccess, signShopOrderAccess } from '@/lib/access-token';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

/* H-211: `GET /api/orders/[orderId]` y `/api/shop/orders/[orderId]` devolvían la fila entera al portador del token: `notes` (campo interno que escribe el admin en la tienda),
 * `soldById`, `idempotencyKey`, `paymentId`, `pdfUrl` y los contadores de la cola de reconciliación. El comprador solo necesita saber SI hubo un pago (`hasPayment`). */

const INTERNAL_COMMON = ['idempotencyKey', 'paymentId', 'reconcileCheckedAt', 'reconcileAttempts'];
const INTERNAL_ORDER = [...INTERNAL_COMMON, 'soldById', 'pdfUrl', 'emailLastError'];
const INTERNAL_SHOP = [...INTERNAL_COMMON, 'notes'];

describe('H-211: el pedido que se devuelve al comprador no lleva campos internos', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  let productId: string;
  let shopId: string;
  let orderId: string;

  beforeAll(async () => {
    event = await createTestEvent({ maxCapacity: 10 });
    tt = await createTicketType(event.id, { maxQuantity: 10 });
    const order = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Ana', buyerLastName: 'Gil', buyerEmail: 'h211@example.com', totalAmount: 10, status: 'COMPLETED', paymentMethod: 'CASH', channel: 'TAQUILLA',
        soldById: 'staff-h211', pdfUrl: 'https://example.com/interno.pdf', idempotencyKey: `h211-${Date.now()}`, paymentProvider: 'stripe', paymentId: 'cs_h211_interno',
        tickets: { create: { eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-H211-${Date.now()}`, holderName: 'Ana', status: 'VALID' } },
      },
    });
    orderId = order.id;
    const product = await prisma.product.create({ data: { name: '[TEST] H211', slug: `h211-${Date.now()}`, price: 10, sizes: 'M', colors: 'Negro', isActive: true } });
    productId = product.id;
    const shop = await prisma.shopOrder.create({
      data: {
        buyerName: 'Luis', buyerEmail: 'h211-shop@example.com', shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001', totalAmount: 10, status: 'PAID',
        paymentProvider: 'stripe', paymentId: 'cs_h211_shop', notes: 'NOTA INTERNA DEL ADMIN: cliente conflictivo', idempotencyKey: `h211s-${Date.now()}`,
        items: { create: [{ productId, quantity: 1, unitPrice: 10, size: 'M', color: 'Negro' }] },
      },
    });
    shopId = shop.id;
  });
  afterAll(async () => {
    await prisma.shopOrderItem.deleteMany({ where: { productId } });
    await prisma.shopOrder.deleteMany({ where: { id: shopId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
  });

  it('entradas: sin los campos internos, con `hasPayment` y con lo que la pantalla necesita', async () => {
    const res = await getOrder(new Request(`http://localhost/api/orders/${orderId}?t=${encodeURIComponent(signOrderAccess(orderId))}`), { params: Promise.resolve({ orderId }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    for (const key of INTERNAL_ORDER) expect(body, key).not.toHaveProperty(key);
    expect(JSON.stringify(body)).not.toMatch(/cs_h211_interno|staff-h211|interno\.pdf/);
    expect(body.hasPayment).toBe(true);
    expect(body).toMatchObject({ id: orderId, status: 'COMPLETED', buyerName: 'Ana', totalAmount: 10 });
    expect(body.tickets).toHaveLength(1);
    expect(body.event).toBeTruthy();
  });

  it('tienda: sin `notes` ni los demás campos internos, con `hasPayment` y con lo que la pantalla necesita', async () => {
    const res = await getShopOrder(new Request(`http://localhost/api/shop/orders/${shopId}?t=${encodeURIComponent(signShopOrderAccess(shopId))}`), { params: Promise.resolve({ orderId: shopId }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    for (const key of INTERNAL_SHOP) expect(body, key).not.toHaveProperty(key);
    expect(JSON.stringify(body)).not.toMatch(/NOTA INTERNA|cs_h211_shop/);
    expect(body.hasPayment).toBe(true);
    expect(body).toMatchObject({ id: shopId, status: 'PAID', buyerName: 'Luis', totalAmount: 10 });
    expect(body.items).toHaveLength(1);
  });

  it('un pedido sin pago asociado dice `hasPayment: false`', async () => {
    await prisma.shopOrder.update({ where: { id: shopId }, data: { paymentProvider: null, paymentId: null } });
    const res = await getShopOrder(new Request(`http://localhost/api/shop/orders/${shopId}?t=${encodeURIComponent(signShopOrderAccess(shopId))}`), { params: Promise.resolve({ orderId: shopId }) });
    expect((await res.json()).hasPayment).toBe(false);
  });
});
