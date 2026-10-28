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

const { DELETE: deleteTicketType, PUT: updateTicketType } = await import('@/app/api/admin/ticket-types/[id]/route');
const { POST: createTicketTypeRoute } = await import('@/app/api/admin/ticket-types/route');

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

    const res = await deleteTicketType(new Request('http://localhost'), { params: Promise.resolve({ id: ticketType.id }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/entradas vendidas/i);

    const stillExists = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(stillExists).not.toBeNull();
  });

  it('permite borrar un tipo de entrada sin ventas', async () => {
    const ticketType = await createTicketType(event.id);
    const res = await deleteTicketType(new Request('http://localhost'), { params: Promise.resolve({ id: ticketType.id }) });
    expect(res.status).toBe(200);
    const gone = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(gone).toBeNull();
  });
});

/* P1-07: precio 0 (gratuita) o al menos 0,50 € (el mínimo de Stripe). Solo se exige al CREAR y al CAMBIAR el precio: editar otro campo de un tipo antiguo con un
 * precio menor no debe fallar. */
describe('precio mínimo de los tipos de entrada (0 o ≥ 0,50 €)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  beforeAll(async () => {
    event = await createTestEvent();
  });
  afterAll(async () => {
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
  });

  const put = (id: string, body: unknown) =>
    updateTicketType(new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const create = (price: number) =>
    createTicketTypeRoute(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ eventId: event.id, name: `T-${price}`, price }) }));

  it('crear con 0,30 € se rechaza; con 0, 0,50 o 12 se acepta', async () => {
    expect((await create(0.3)).status).toBeGreaterThanOrEqual(400);
    for (const price of [0, 0.5, 12]) expect((await create(price)).status).toBe(200);
  });

  it('cambiar el precio a 0,30 € se rechaza con un mensaje claro y no lo guarda', async () => {
    const tt = await createTicketType(event.id, { price: 10 });
    const res = await put(tt.id, { price: 0.3 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/0,50/);
    expect(Number((await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).price)).toBe(10);
  });

  it('editar otro campo de un tipo antiguo con precio de 0,30 € (el formulario reenvía el precio) NO falla', async () => {
    const tt = await createTicketType(event.id, { price: 0.3 });
    const res = await put(tt.id, { name: 'Renombrado', price: 0.3 });
    expect(res.status).toBe(200);
    expect((await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).name).toBe('Renombrado');
  });
});
