import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { vi } from 'vitest';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-stats-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: getStats } = await import('@/app/api/admin/stats/route');

function statsRequest(query: string) {
  return new Request(`http://localhost/api/admin/stats${query}`);
}

// AUDIT: "Entradas vendidas" filtraba solo por evento, ignorando el rango de
// fechas que sí aplicaban "Ingresos brutos/netos" y "Nº de pedidos" — al
// elegir "Últimos 7 días" en /admin/estadisticas, el contador de entradas
// podía incluir entradas mucho más antiguas mientras los ingresos mostrados
// sí respetaban el rango, dando cifras inconsistentes en la misma pantalla.
describe('GET /api/admin/stats — coherencia de fechas entre entradas e ingresos', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;
  let oldOrderId: string;
  let recentOrderId: string;

  beforeAll(async () => {
    event = await createTestEvent();
    ticketType = await createTicketType(event.id, { maxQuantity: 20 });

    const oldOrder = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Old', buyerLastName: 'Order', buyerEmail: `old-${Date.now()}@example.com`,
        totalAmount: 10, status: 'COMPLETED',
        tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-OLD-${Date.now()}`, holderName: 'Old Ticket', status: 'VALID' } },
      },
    });
    oldOrderId = oldOrder.id;
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    await prisma.order.update({ where: { id: oldOrderId }, data: { createdAt: oldDate } });
    await prisma.ticket.updateMany({ where: { orderId: oldOrderId }, data: { createdAt: oldDate } });

    const recentOrder = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Recent', buyerLastName: 'Order', buyerEmail: `recent-${Date.now()}@example.com`,
        totalAmount: 10, status: 'COMPLETED',
        tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-RECENT-${Date.now()}`, holderName: 'Recent Ticket', status: 'VALID' } },
      },
    });
    recentOrderId = recentOrder.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: { in: [oldOrderId, recentOrderId] } } });
    await cleanupTestEvent(event.id);
  });

  it('sin filtro de fecha, cuenta las entradas de ambos pedidos', async () => {
    const res = await getStats(statsRequest(`?eventId=${event.id}`));
    const data = await res.json();
    expect(data.totalTickets).toBeGreaterThanOrEqual(2);
  });

  it('con "from" reciente, "Entradas vendidas" excluye el pedido antiguo igual que los ingresos', async () => {
    const from = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const res = await getStats(statsRequest(`?eventId=${event.id}&from=${encodeURIComponent(from)}`));
    const data = await res.json();
    // Solo el pedido reciente entra en el rango: 1 pedido, 1 entrada, 10€.
    expect(data.totalOrders).toBe(1);
    expect(data.totalTickets).toBe(1);
    expect(data.totalRevenue).toBe(10);
  });
});
