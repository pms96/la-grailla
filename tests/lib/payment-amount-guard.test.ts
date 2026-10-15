import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('@/lib/mailer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mailer')>('@/lib/mailer');
  return { ...actual, sendMail: vi.fn(async () => ({ success: true })) };
});

const { completeOrder } = await import('@/lib/reconciliation/entradas');
const { completeShopOrder } = await import('@/lib/reconciliation/tienda');

// AUDIT: un pedido pasaba a pagado solo porque la pasarela dijera "pagado": nunca se comparaba el importe cobrado con el total del
// pedido. Un cobro de 1 € sobre un pedido de 25 € se daba por bueno. Severidad: Alto (dinero).
describe('Confirmación de pago — el importe cobrado debe cuadrar con el pedido', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  const orderIds: string[] = [];
  const shopOrderIds: string[] = [];

  beforeAll(async () => {
    event = await createTestEvent();
  });

  afterAll(async () => {
    await prisma.shopOrder.deleteMany({ where: { id: { in: shopOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await cleanupTestEvent(event.id);
  });

  async function newOrder(totalAmount = 25) {
    const o = await prisma.order.create({
      data: { eventId: event.id, buyerName: 'Ana', buyerLastName: 'Pago', buyerEmail: 'pago-guard@example.com', totalAmount, status: 'PENDING', paymentProvider: 'sumup', paymentId: 'chk_test' },
    });
    orderIds.push(o.id);
    return o;
  }
  async function newShopOrder(totalAmount = 20) {
    const o = await prisma.shopOrder.create({
      data: { buyerName: 'Luis', buyerEmail: 'pago-guard-shop@example.com', shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001', totalAmount, status: 'PENDING', paymentProvider: 'sumup', paymentId: 'chk_test' },
    });
    shopOrderIds.push(o.id);
    return o;
  }

  it('entradas: un cobro menor que el total NO completa el pedido', async () => {
    const o = await newOrder(25);
    await completeOrder(o.id, undefined, { amount: 1, currency: 'EUR' });
    expect((await prisma.order.findUnique({ where: { id: o.id } }))?.status).toBe('PENDING');
  });

  it('entradas: un cobro en otra moneda NO completa el pedido', async () => {
    const o = await newOrder(25);
    await completeOrder(o.id, undefined, { amount: 25, currency: 'USD' });
    expect((await prisma.order.findUnique({ where: { id: o.id } }))?.status).toBe('PENDING');
  });

  it('entradas: el importe exacto (con la tolerancia de un céntimo) sí completa', async () => {
    const o = await newOrder(25);
    await completeOrder(o.id, undefined, { amount: 25, currency: 'eur' });
    expect((await prisma.order.findUnique({ where: { id: o.id } }))?.status).toBe('COMPLETED');
  });

  it('entradas: si la pasarela no informa del importe, se comporta como siempre', async () => {
    const o = await newOrder(25);
    await completeOrder(o.id);
    expect((await prisma.order.findUnique({ where: { id: o.id } }))?.status).toBe('COMPLETED');
  });

  it('tienda: un cobro menor que el total NO marca el pedido como pagado', async () => {
    const o = await newShopOrder(20);
    await completeShopOrder(o.id, { amount: 2, currency: 'EUR' });
    expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('PENDING');
  });

  it('tienda: el importe exacto sí marca el pedido como pagado', async () => {
    const o = await newShopOrder(20);
    await completeShopOrder(o.id, { amount: 20, currency: 'EUR' });
    expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('PAID');
  });

  it('tienda: sin importe informado se comporta como siempre', async () => {
    const o = await newShopOrder(20);
    await completeShopOrder(o.id);
    expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('PAID');
  });
});
