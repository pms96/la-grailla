// AUDIT: DATA-01 — GET /api/admin/stats computa totalRevenue/netRevenue y
// byChannel[].revenue a partir de prisma.order.aggregate()/groupBy() (_sum).
// Los resultados de aggregate() no son instancias de modelo, así que no pasan
// por la extensión de lib/prisma.ts que convierte Decimal a number en el
// resto de la app tras la migración de Order.totalAmount/commission a
// Decimal(10,2) — sin una conversión explícita, estos tres valores se
// serializarían en la respuesta JSON como STRING (Decimal.toJSON()) en vez de
// number, rompiendo en silencio el dashboard de admin (que hace
// o.totalAmount.toFixed(2) esperando un number).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, cleanupTestEvent } from '../../tests/helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-data01-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: getStats } = await import('@/app/api/admin/stats/route');

describe('AUDIT — /api/admin/stats devuelve number (no string) en los campos derivados de aggregate()', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let orderId: string;

  beforeAll(async () => {
    event = await createTestEvent();
    const order = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Test', buyerLastName: 'DATA01', buyerEmail: 'data01-stats@test.local',
        totalAmount: 36.5, commission: 1.5, status: 'COMPLETED', channel: 'ONLINE',
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await prisma.order.delete({ where: { id: orderId } }).catch(() => {});
    await cleanupTestEvent(event.id);
  });

  it('totalRevenue, netRevenue y byChannel[].revenue son number con el valor correcto', async () => {
    const res = await getStats(new Request(`http://localhost/api/admin/stats?eventId=${event.id}`));
    expect(res.status).toBe(200);
    const raw = await res.text();
    const data = JSON.parse(raw);

    expect(typeof data.totalRevenue).toBe('number');
    expect(data.totalRevenue).toBe(36.5);
    expect(typeof data.netRevenue).toBe('number');
    expect(data.netRevenue).toBe(35);

    const online = data.byChannel.find((c: { channel: string }) => c.channel === 'ONLINE');
    expect(typeof online.revenue).toBe('number');
    expect(online.revenue).toBe(36.5);

    // Cinturón y tirantes: si algún cambio futuro reintroduce el bug, el
    // Decimal crudo serializa como comilla en el JSON crudo — comprobamos el
    // texto de la respuesta, no solo el objeto ya parseado por JSON.parse.
    expect(raw).toContain('"totalRevenue":36.5');
    expect(raw).not.toMatch(/"totalRevenue":"36\.5"/);
  });
});
