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
        buyerName: 'Cancelado',
        buyerLastName: 'Anulado',
        buyerEmail: 'cancelado-anulado@example.com',
        totalAmount: 99,
        status: 'CANCELLED',
      },
    });
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

  // H-137: la pantalla con el filtro «Todos» no manda `status`; el servidor usaba COMPLETED por defecto y el CSV no era lo que se veía.
  it('sin filtro de estado exporta todos, igual que la pantalla, con columna de estado', async () => {
    const csv = await (await exportCsv(new Request(`http://localhost/api/admin/export?type=orders&eventId=${event.id}`))).text();
    expect(csv).toContain('cancelado-anulado@example.com');
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toContain('estado');
    expect(lines.find((l) => l.includes('cancelado-anulado@example.com'))).toContain('Cancelado');
  });

  it('con status=COMPLETED solo los completados', async () => {
    const csv = await (await exportCsv(new Request(`http://localhost/api/admin/export?type=orders&eventId=${event.id}&status=COMPLETED`))).text();
    expect(csv).toContain('otro-comprador@example.com');
    expect(csv).not.toContain('cancelado-anulado@example.com');
  });

  it('formato de Excel español: «;», coma decimal y fecha de Madrid, no ISO', async () => {
    const csv = await (await exportCsv(new Request(`http://localhost/api/admin/export?type=orders&eventId=${event.id}&q=filtrado-encontrado`))).text();
    const line = csv.slice(1).split('\r\n')[1];
    expect(line).toContain('20,00');
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(line).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  });

  it('si hay más pedidos que el tope responde 413 con mensaje, sin truncar y sin dejar rastro de una exportación que no ocurrió', async () => {
    const antes = await prisma.adminAuditLog.count({ where: { action: 'export.orders' } });
    const spy = vi.spyOn(prisma.order, 'count').mockResolvedValueOnce(6000);
    const res = await exportCsv(new Request(`http://localhost/api/admin/export?type=orders&eventId=${event.id}`));
    spy.mockRestore();
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('6000');
    expect(await prisma.adminAuditLog.count({ where: { action: 'export.orders' } })).toBe(antes);
  });

  it('asistentes: más entradas que el tope responde 413 en lugar de truncar', async () => {
    const spy = vi.spyOn(prisma.ticket, 'count').mockResolvedValueOnce(12000);
    const res = await exportCsv(new Request(`http://localhost/api/admin/export?type=tickets&eventId=${event.id}`));
    spy.mockRestore();
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('12000');
  });
});
