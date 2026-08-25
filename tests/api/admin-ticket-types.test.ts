import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: 'admin-test', role: 'ADMIN', email: 'admin@test.local' },
  })),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

const { DELETE: deleteTicketType } = await import('@/app/api/admin/ticket-types/[id]/route');

describe('DELETE /api/admin/ticket-types/[id]', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    event = await createTestEvent();
  });

  afterAll(async () => {
    await cleanupTestEvent(event.id);
  });

  // AUDIT: borrar un tipo de entrada con tickets ya emitidos reventaba con
  // un error crudo de Prisma (FK constraint) en vez de un mensaje claro.
  // Severidad: Medio.
  it('rechaza con un mensaje claro si ya hay entradas emitidas de ese tipo', async () => {
    const ticketType = await createTicketType(event.id);
    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Titular',
        buyerLastName: 'Test',
        buyerEmail: 'titular-test@example.com',
        totalAmount: 10,
        status: 'COMPLETED',
      },
    });
    await prisma.ticket.create({
      data: {
        eventId: event.id,
        ticketTypeId: ticketType.id,
        orderId: order.id,
        qrCode: `QR-TT-${Date.now()}`,
        holderName: 'Titular test',
        status: 'VALID',
      },
    });

    const res = await deleteTicketType(new Request('http://localhost'), { params: { id: ticketType.id } });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/entradas vendidas/i);

    const stillExists = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(stillExists).not.toBeNull();
  });

  it('permite borrar un tipo de entrada sin ventas', async () => {
    const ticketType = await createTicketType(event.id);
    const res = await deleteTicketType(new Request('http://localhost'), { params: { id: ticketType.id } });
    expect(res.status).toBe(200);
    const gone = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(gone).toBeNull();
  });
});
