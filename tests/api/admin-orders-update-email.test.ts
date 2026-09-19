import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-orders-email-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { PATCH: patchOrder } = await import('@/app/api/admin/orders/[id]/route');

function patchRequest(body: unknown) {
  return new Request('http://localhost', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// AUDIT: un comprador que escribe mal su email nunca recibe sus entradas y,
// hasta ahora, no había forma de corregirlo desde el admin — solo se podía
// reenviar al mismo email erróneo una y otra vez. update-email corrige el
// dato en el pedido; "Reenviar entradas" (ya existente) hace el resto.
describe('PATCH /api/admin/orders/[id] — update-email', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;

  beforeAll(async () => {
    event = await createTestEvent();
    ticketType = await createTicketType(event.id, { maxQuantity: 20 });
  });

  afterAll(async () => {
    await cleanupTestEvent(event.id);
  });

  async function createOrder(buyerEmail: string) {
    return prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Email', buyerLastName: 'Test', buyerEmail,
        totalAmount: 10, status: 'COMPLETED',
        tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-EMAIL-${Date.now()}-${Math.random()}`, holderName: 'Email Test', status: 'VALID' } },
      },
    });
  }

  it('rechaza a quien no es admin', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({ user: { id: 'u1', role: 'TAQUILLA' } } as never);
    const order = await createOrder(`typo-${Date.now()}@example.con`);
    const res = await patchOrder(patchRequest({ action: 'update-email', email: 'ok@example.com' }), { params: { id: order.id } });
    expect(res.status).toBe(401);
  });

  it('corrige el email del pedido', async () => {
    const order = await createOrder(`typo-${Date.now()}@example.con`);
    const res = await patchOrder(
      patchRequest({ action: 'update-email', email: 'corregido@example.com' }),
      { params: { id: order.id } }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyerEmail).toBe('corregido@example.com');

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.buyerEmail).toBe('corregido@example.com');
  });

  it('recorta espacios sobrantes en el email', async () => {
    const order = await createOrder(`typo-${Date.now()}@example.con`);
    const res = await patchOrder(
      patchRequest({ action: 'update-email', email: '  espacios@example.com  ' }),
      { params: { id: order.id } }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyerEmail).toBe('espacios@example.com');
  });

  it('rechaza un email con formato inválido', async () => {
    const order = await createOrder(`typo-${Date.now()}@example.con`);
    const res = await patchOrder(
      patchRequest({ action: 'update-email', email: 'no-es-un-email' }),
      { params: { id: order.id } }
    );
    expect(res.status).toBe(400);

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.buyerEmail).not.toBe('no-es-un-email');
  });

  it('rechaza sin email', async () => {
    const order = await createOrder(`typo-${Date.now()}@example.con`);
    const res = await patchOrder(patchRequest({ action: 'update-email' }), { params: { id: order.id } });
    expect(res.status).toBe(422);
  });
});
