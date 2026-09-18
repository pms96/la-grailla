import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-orders-verify-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { PATCH: patchOrder } = await import('@/app/api/admin/orders/[id]/route');

function patchRequest(action: string) {
  return new Request('http://localhost', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

function mockSumUpFetch(statusByCheckoutId: Record<string, string>) {
  return vi.fn(async (url: string | URL) => {
    const id = url.toString().split('/').pop();
    const status = id ? statusByCheckoutId[id] : undefined;
    if (!status) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify({ status }), { status: 200 });
  });
}

// AUDIT: un webhook de pago que nunca llega (secreto mal configurado, evento
// no entregado...) deja el pedido en PENDING aunque el cobro real se haya
// hecho — antes de esto no existía ninguna forma de resolverlo desde el
// admin salvo cancelar (que no devuelve el dinero) o esperar a que el
// comprador revisitara /confirmacion. "Verificar pago" reintenta la
// comprobación contra la pasarela; "Marcar como pagado" es el último
// recurso manual cuando el admin ya tiene prueba de cobro fuera de la app.
describe('PATCH /api/admin/orders/[id] — verify y complete', () => {
  let originalApiKey: string | null;
  let originalMerchantCode: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;

  beforeAll(async () => {
    originalApiKey = await getAndSetConfig('sumup_api_key', 'test-key');
    originalMerchantCode = await getAndSetConfig('sumup_merchant_code', 'MTEST');
    event = await createTestEvent();
    ticketType = await createTicketType(event.id, { maxQuantity: 20 });
  });

  afterAll(async () => {
    await restoreConfig('sumup_api_key', originalApiKey);
    await restoreConfig('sumup_merchant_code', originalMerchantCode);
    await cleanupTestEvent(event.id);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function createPendingOrder(paymentId: string | null) {
    return prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Verify', buyerLastName: 'Test',
        buyerEmail: `verify-${paymentId ?? 'none'}-${Date.now()}@example.com`,
        totalAmount: 10, paymentProvider: paymentId ? 'sumup' : null, paymentId, status: 'PENDING',
        tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-VERIFY-${Date.now()}-${Math.random()}`, holderName: 'Verify Test', status: 'PENDING' } },
      },
    });
  }

  it('rechaza a quien no es admin', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({ user: { id: 'u1', role: 'TAQUILLA' } } as never);
    const order = await createPendingOrder(null);
    const res = await patchOrder(patchRequest('verify'), { params: { id: order.id } });
    expect(res.status).toBe(401);
  });

  it('verify: confirma y completa el pedido cuando la pasarela reporta el pago', async () => {
    const paymentId = `chk-verify-ok-${Date.now()}`;
    const order = await createPendingOrder(paymentId);
    vi.stubGlobal('fetch', mockSumUpFetch({ [paymentId]: 'PAID' }));

    const res = await patchOrder(patchRequest('verify'), { params: { id: order.id } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('COMPLETED');

    const tickets = await prisma.ticket.findMany({ where: { orderId: order.id } });
    expect(tickets.every((t) => t.status === 'VALID')).toBe(true);
  });

  it('verify: deja el pedido en PENDING si la pasarela no confirma el pago', async () => {
    const paymentId = `chk-verify-pending-${Date.now()}`;
    const order = await createPendingOrder(paymentId);
    vi.stubGlobal('fetch', mockSumUpFetch({ [paymentId]: 'PENDING' }));

    const res = await patchOrder(patchRequest('verify'), { params: { id: order.id } });
    expect(res.status).toBe(422);

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe('PENDING');
  });

  it('verify: rechaza si el pedido no tiene pago asociado en ninguna pasarela', async () => {
    const order = await createPendingOrder(null);
    const res = await patchOrder(patchRequest('verify'), { params: { id: order.id } });
    expect(res.status).toBe(422);
  });

  it('complete: marca como pagado sin consultar la pasarela y envía las entradas', async () => {
    const order = await createPendingOrder(null);
    const res = await patchOrder(patchRequest('complete'), { params: { id: order.id } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('COMPLETED');

    const tickets = await prisma.ticket.findMany({ where: { orderId: order.id } });
    expect(tickets.every((t) => t.status === 'VALID')).toBe(true);
  });

  it('complete: rechaza un pedido que ya no está pendiente', async () => {
    const order = await createPendingOrder(null);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    const res = await patchOrder(patchRequest('complete'), { params: { id: order.id } });
    expect(res.status).toBe(422);
  });
});
