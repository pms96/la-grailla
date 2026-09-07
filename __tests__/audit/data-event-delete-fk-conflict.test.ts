// AUDIT: DATA-03 — DELETE /api/admin/events/[id] no comprobaba si el evento
// tenía Order/Ticket antes de borrarlo (a diferencia de ticket-types/[id], que
// sí lo hace). Ticket -> Event es RESTRICT, no CASCADE, así que Prisma lanza
// PrismaClientKnownRequestError P2003 (violación de clave foránea) — y
// lib/api-error.ts no lo mapeaba, así que caía en el 500 genérico en vez de un
// 409 que explique al admin por qué no se puede borrar.
//
// Se arregla mapeando P2003 a 409 en handleApiError (lib/api-error.ts), lo que
// protege este endpoint y cualquier otro DELETE del proyecto con el mismo
// problema, en vez de un precheck puntual solo en events/[id].
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../../tests/helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { DELETE: deleteEvent } = await import('@/app/api/admin/events/[id]/route');

function deleteRequest() {
  return new Request('http://localhost/api/admin/events/x', { method: 'DELETE' });
}

describe('AUDIT — DELETE /api/admin/events/[id] con Order/Ticket dependientes', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let orderId: string;

  beforeAll(async () => {
    event = await createTestEvent();
    const ticketType = await createTicketType(event.id);
    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Test',
        buyerLastName: 'Audit',
        buyerEmail: 'audit-data03@test.local',
        totalAmount: 10,
        commission: 0,
        paymentMethod: 'CASH',
        status: 'COMPLETED',
        channel: 'TAQUILLA',
      },
    });
    orderId = order.id;
    await prisma.ticket.create({
      data: {
        orderId: order.id,
        eventId: event.id,
        ticketTypeId: ticketType.id,
        qrCode: `audit-data03-${Date.now()}`,
        holderName: 'Test Audit',
        status: 'VALID',
      },
    });
  });

  afterAll(async () => {
    await cleanupTestEvent(event.id);
  });

  it('devuelve 409 (no 500) en vez de reventar por la clave foránea', async () => {
    const res = await deleteEvent(deleteRequest(), { params: { id: event.id } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/no se puede eliminar/i);

    // El evento sigue existiendo: el borrado se rechazó, no se dejó a medias.
    const stillExists = await prisma.event.findUnique({ where: { id: event.id } });
    expect(stillExists).not.toBeNull();

    await prisma.ticket.deleteMany({ where: { orderId } });
    await prisma.order.delete({ where: { id: orderId } });
  });

  it('un evento sin pedidos/entradas sí se puede borrar', async () => {
    const emptyEvent = await createTestEvent();
    const res = await deleteEvent(deleteRequest(), { params: { id: emptyEvent.id } });
    expect(res.status).toBe(200);
    const stillExists = await prisma.event.findUnique({ where: { id: emptyEvent.id } });
    expect(stillExists).toBeNull();
  });
});
