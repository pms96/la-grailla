import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

let currentRole: string | null = 'ADMIN';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (currentRole ? { user: { id: 'tester', role: currentRole } } : null)),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

const { GET: getCapacity } = await import('@/app/api/access/capacity/route');

function capacityRequest(eventId?: string) {
  const url = eventId
    ? `http://localhost/api/access/capacity?eventId=${eventId}`
    : 'http://localhost/api/access/capacity';
  return new Request(url);
}

describe('GET /api/access/capacity', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketTypeA: Awaited<ReturnType<typeof createTicketType>>;
  let ticketId: string;

  beforeAll(async () => {
    event = await createTestEvent({ maxCapacity: 200 });
    ticketTypeA = await createTicketType(event.id, { maxQuantity: 50 });

    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Cap', buyerLastName: 'Test', buyerEmail: 'cap@example.com',
        totalAmount: 10, status: 'COMPLETED',
        tickets: {
          create: {
            eventId: event.id,
            ticketTypeId: ticketTypeA.id,
            qrCode: `QR-CAP-${Date.now()}`,
            holderName: 'Cap Test',
            status: 'VALID',
          },
        },
      },
      include: { tickets: true },
    });
    ticketId = order.tickets[0].id;

    await prisma.event.update({ where: { id: event.id }, data: { currentCount: 3 } });
  });

  afterAll(async () => {
    await prisma.scanLog.deleteMany({ where: { ticketId } });
    await cleanupTestEvent(event.id);
  });

  it('rechaza sin sesión', async () => {
    currentRole = null;
    const res = await getCapacity(capacityRequest(event.id));
    expect(res.status).toBe(401);
    currentRole = 'ADMIN';
  });

  it('rechaza a un usuario con rol USER', async () => {
    currentRole = 'USER';
    const res = await getCapacity(capacityRequest(event.id));
    expect(res.status).toBe(401);
    currentRole = 'ADMIN';
  });

  it('permite el rol TAQUILLA además de ADMIN', async () => {
    currentRole = 'TAQUILLA';
    const res = await getCapacity(capacityRequest(event.id));
    expect(res.status).toBe(200);
    currentRole = 'ADMIN';
  });

  it('rechaza si falta eventId', async () => {
    const res = await getCapacity(capacityRequest());
    expect(res.status).toBe(400);
  });

  it('devuelve 404 si el evento no existe', async () => {
    const res = await getCapacity(capacityRequest('no-existe'));
    expect(res.status).toBe(404);
  });

  it('devuelve aforo, vendidas y desglose por tipo de entrada', async () => {
    const res = await getCapacity(capacityRequest(event.id));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.current).toBe(3);
    expect(json.max).toBe(200);
    expect(json.sold).toBe(1);
    expect(json.ticketTypes).toHaveLength(1);
    expect(json.ticketTypes[0].id).toBe(ticketTypeA.id);
    expect(json.ticketTypes[0].maxQuantity).toBe(50);
  });

  it('no cuenta entradas CANCELLED/REFUNDED como vendidas', async () => {
    const cancelledOrder = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Cancel', buyerLastName: 'Test', buyerEmail: 'cancel@example.com',
        totalAmount: 10, status: 'CANCELLED',
        tickets: {
          create: {
            eventId: event.id,
            ticketTypeId: ticketTypeA.id,
            qrCode: `QR-CAP-CANCEL-${Date.now()}`,
            holderName: 'Cancel Test',
            status: 'CANCELLED',
          },
        },
      },
    });

    try {
      const res = await getCapacity(capacityRequest(event.id));
      const json = await res.json();
      expect(json.sold).toBe(1);
    } finally {
      await prisma.ticket.deleteMany({ where: { orderId: cancelledOrder.id } });
      await prisma.order.delete({ where: { id: cancelledOrder.id } });
    }
  });

  it('rejectionRate5min es null cuando no ha habido escaneos recientes', async () => {
    const res = await getCapacity(capacityRequest(event.id));
    const json = await res.json();
    expect(json.entryRate5min).toBe(0);
    expect(json.rejectionRate5min).toBeNull();
  });

  it('calcula ritmo de entrada y tasa de rechazo sobre los últimos 5 minutos', async () => {
    await prisma.scanLog.createMany({
      data: [
        { ticketId, eventId: event.id, result: 'VALID' },
        { ticketId, eventId: event.id, result: 'VALID' },
        { ticketId, eventId: event.id, result: 'DUPLICATE' },
      ],
    });

    // Escaneo fuera de la ventana de 5 minutos: no debe contar para ninguna métrica.
    await prisma.scanLog.create({
      data: { ticketId, eventId: event.id, result: 'VALID', createdAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const res = await getCapacity(capacityRequest(event.id));
    const json = await res.json();

    expect(json.entryRate5min).toBe(2);
    expect(json.rejectionRate5min).toBe(33); // 1 de 3 escaneos recientes no fue VALID
  });
});
