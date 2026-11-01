import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway, paid } from '../helpers/fake-gateway';

const mailer = vi.hoisted(() => ({ sent: [] as { to: string; subject: string }[] }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'manual-paid-admin', role: 'ADMIN' } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/mailer', async (orig) => ({
  ...(await orig<typeof import('@/lib/mailer')>()),
  sendMail: async (p: { to: string; subject: string }) => {
    mailer.sent.push({ to: p.to, subject: p.subject });
    return { success: true, transport: 'smtp' as const };
  },
}));
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return { ...actual, getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)) };
});

const { PUT: putShopOrder } = await import('@/app/api/admin/shop-orders/[id]/route');
const { PATCH: patchOrder } = await import('@/app/api/admin/orders/[id]/route');

/* H-034: «Marcar como pagado» a mano en la tienda era un `update` plano: sin email de confirmación al comprador, sin aviso al vendedor, sin liberar el cupo de
 * pedidos pendientes, sin compare-and-swap y sin cerrar la sesión de pago, de modo que si el comprador pagaba después con tarjeta el cobro quedaba duplicado en
 * silencio. En entradas el marcado ya pasaba por `completeOrder`, pero tampoco cerraba la sesión de pago. Ahora ambos hacen lo mismo que un pago confirmado. */

const put = (id: string, body: unknown) => putShopOrder(new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) => patchOrder(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe('marcar como pagado a mano (H-034)', () => {
  let productId: string;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const shopIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    productId = (await prisma.product.create({ data: { name: `[TEST] Manual ${Date.now()}`, slug: `test-manual-${Date.now()}`, price: 20, isActive: true } })).id;
    event = await createTestEvent();
    tt = await createTicketType(event.id, { maxQuantity: 50 });
  });
  afterAll(async () => {
    await prisma.processedWebhookEvent.deleteMany({ where: { id: { startsWith: 'email:shop:' }, AND: { id: { in: shopIds.flatMap((i) => [`email:shop:${i}:due`]) } } } }).catch(() => {});
    await prisma.shopOrderItem.deleteMany({ where: { productId } });
    await prisma.shopOrder.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.product.delete({ where: { id: productId } }).catch(() => {});
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
  });
  beforeEach(() => {
    gateway.reset();
    gateway.active = true;
    mailer.sent = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  async function shop(over: { status?: 'PENDING' | 'PAID'; paymentId?: string | null; total?: number } = {}) {
    const paymentId = over.paymentId === undefined ? `cs_manual_${Date.now()}_${n++}` : over.paymentId;
    const o = await prisma.shopOrder.create({
      data: {
        buyerName: 'Luis', buyerEmail: `manual-${Date.now()}-${n}@example.com`, shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001',
        totalAmount: over.total ?? 40, status: over.status ?? 'PENDING', paymentProvider: paymentId ? 'fake' : null, paymentId,
        items: { create: [{ productId, quantity: 2, unitPrice: 20 }] },
      },
    });
    shopIds.push(o.id);
    return o;
  }
  const shopStatus = async (id: string) => (await prisma.shopOrder.findUniqueOrThrow({ where: { id } })).status;

  describe('tienda', () => {
    it('PENDING→PAID a mano confirma el pedido por el flujo normal: el comprador recibe su email y se anota la entrega', async () => {
      const o = await shop();
      const res = await put(o.id, { status: 'PAID' });
      expect(res.status).toBe(200);
      expect(await shopStatus(o.id)).toBe('PAID');
      expect(mailer.sent.some((m) => m.to === o.buyerEmail)).toBe(true);
    });

    it('cierra la sesión de pago abierta: si el comprador pagara después con tarjeta, ya no puede', async () => {
      const o = await shop();
      await put(o.id, { status: 'PAID' });
      expect(gateway.count('cancel', o.paymentId!)).toBe(1);
    });

    it('si la sesión resulta estar YA pagada, se completa con lo cobrado en la pasarela (no se pierde el importe) y el pedido queda PAID', async () => {
      const o = await shop({ total: 40 });
      gateway.script(o.paymentId!, paid(o.paymentId!, 40));
      expect((await put(o.id, { status: 'PAID' })).status).toBe(200);
      expect(await shopStatus(o.id)).toBe('PAID');
    });

    it('si la pasarela dice que lo cobrado NO cuadra con el pedido, no lo marca como pagado y lo explica (422)', async () => {
      const o = await shop({ total: 40 });
      gateway.script(o.paymentId!, paid(o.paymentId!, 5));
      const res = await put(o.id, { status: 'PAID' });
      expect(res.status).toBe(422);
      expect(await shopStatus(o.id)).toBe('PENDING');
      expect(mailer.sent.some((m) => m.to === o.buyerEmail)).toBe(false);
    });

    it('un pedido sin sesión de pago (efectivo, transferencia) también se confirma y avisa al comprador', async () => {
      const o = await shop({ paymentId: null });
      expect((await put(o.id, { status: 'PAID' })).status).toBe(200);
      expect(await shopStatus(o.id)).toBe('PAID');
      expect(mailer.sent.some((m) => m.to === o.buyerEmail)).toBe(true);
    });

    it('dos marcados simultáneos confirman una sola vez: un solo email al comprador', async () => {
      const o = await shop();
      await Promise.all([put(o.id, { status: 'PAID' }), put(o.id, { status: 'PAID' })]);
      expect(await shopStatus(o.id)).toBe('PAID');
      expect(mailer.sent.filter((m) => m.to === o.buyerEmail)).toHaveLength(1);
    });

    it('un cambio de estado que no es PENDING→PAID sigue siendo plano (PAID→PROCESSING no manda email)', async () => {
      const o = await shop({ status: 'PAID' });
      expect((await put(o.id, { status: 'PROCESSING' })).status).toBe(200);
      expect(mailer.sent.some((m) => m.to === o.buyerEmail)).toBe(false);
    });
  });

  describe('entradas', () => {
    async function ticketOrder() {
      const id = `manual-${Date.now()}-${n++}`;
      const o = await prisma.order.create({
        data: {
          id, eventId: event.id, buyerName: 'Ana', buyerLastName: 'Gil', buyerEmail: `${id}@example.com`, totalAmount: 10, status: 'PENDING', paymentMethod: 'CARD',
          paymentProvider: 'fake', paymentId: `cs_${id}`,
          tickets: { create: [{ eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-${id}`, holderName: 'Ana', status: 'PENDING' }] },
        },
      });
      return o;
    }

    it('«Marcar como pagado» cierra antes la sesión de pago abierta', async () => {
      const o = await ticketOrder();
      const res = await patch(o.id, { action: 'complete' });
      expect(res.status).toBe(200);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('COMPLETED');
      expect(gateway.count('cancel', o.paymentId!)).toBe(1);
    });

    it('si la sesión resulta estar ya pagada, se completa con lo cobrado (y un importe que no cuadra no se completa)', async () => {
      const bad = await ticketOrder();
      gateway.script(bad.paymentId!, paid(bad.paymentId!, 3));
      const res = await patch(bad.id, { action: 'complete' });
      expect(res.status).toBe(422);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe('PENDING');
    });
  });
});
