import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: 'admin-test', role: 'ADMIN', email: 'admin@test.local' },
  })),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

const { GET: exportCsv } = await import('@/app/api/admin/export/route');

describe('GET /api/admin/export (orders)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let matchingOrderId: string;

  beforeAll(async () => {
    event = await createTestEvent();
    const matching = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Filtrado',
        buyerLastName: 'Encontrado',
        buyerEmail: 'filtrado-encontrado@example.com',
        totalAmount: 20,
        status: 'COMPLETED',
      },
    });
    matchingOrderId = matching.id;
    await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Otro',
        buyerLastName: 'Comprador',
        buyerEmail: 'otro-comprador@example.com',
        totalAmount: 15,
        status: 'COMPLETED',
      },
    });
  });

  afterAll(async () => {
    await cleanupTestEvent(event.id);
  });

  // AUDIT: exportar CSV desde /admin/ventas ignoraba el filtro de búsqueda
  // (q) activo en pantalla y descargaba todos los pedidos del evento en vez
  // del subconjunto filtrado. Severidad: Medio.
  it('solo incluye los pedidos que cumplen el filtro de búsqueda (q)', async () => {
    const url = `http://localhost/api/admin/export?type=orders&eventId=${event.id}&q=filtrado-encontrado`;
    const res = await exportCsv(new Request(url));
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain(matchingOrderId);
    expect(csv).not.toContain('otro-comprador@example.com');
  });

  it('sin filtro q incluye todos los pedidos completados del evento', async () => {
    const url = `http://localhost/api/admin/export?type=orders&eventId=${event.id}`;
    const res = await exportCsv(new Request(url));
    const csv = await res.text();
    expect(csv).toContain('filtrado-encontrado@example.com');
    expect(csv).toContain('otro-comprador@example.com');
  });
});
