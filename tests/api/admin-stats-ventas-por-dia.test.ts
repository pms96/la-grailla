import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

let sessionRole: 'ADMIN' | 'TAQUILLA' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-ventas-dia-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET } = await import('@/app/api/admin/stats/ventas-por-dia/route');

const get = (qs: string) => GET(new Request(`http://localhost/api/admin/stats/ventas-por-dia?${qs}`));

// AUDIT: las estadísticas solo daban el total por día; no había forma de
// separar lo vendido online, en taquilla con tarjeta y en taquilla en efectivo.
describe('GET /api/admin/stats/ventas-por-dia', () => {
  let eventId: string;
  let temporadaId: string;

  const baseOrder = { buyerName: 'T', buyerLastName: 'T', buyerEmail: 't@example.com', status: 'COMPLETED' as const };

  beforeAll(async () => {
    const event = await createTestEvent();
    eventId = event.id;
    const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada ventas día', anio: 2097 } });
    temporadaId = temporada.id;

    const mk = async (createdAt: string, totalAmount: number, channel: string, paymentMethod: 'CARD' | 'CASH' | 'FREE', tickets: number) => {
      const order = await prisma.order.create({ data: { ...baseOrder, eventId, createdAt: new Date(createdAt), totalAmount, channel, paymentMethod } });
      for (let i = 0; i < tickets; i++) {
        await prisma.ticket.create({ data: { orderId: order.id, eventId, qrCode: `qr-ventas-dia-${order.id}-${i}`, holderName: 'T' } });
      }
    };
    await mk('2026-09-25T18:00:00Z', 20, 'ONLINE', 'CARD', 2);
    await mk('2026-09-25T19:00:00Z', 30, 'TAQUILLA', 'CASH', 3);
    await mk('2026-09-25T20:00:00Z', 10, 'TAQUILLA', 'CARD', 1);
    await mk('2026-09-26T12:00:00Z', 40, 'ONLINE', 'CARD', 4);

    await prisma.ingreso.create({ data: { temporadaId, concepto: 'Entradas', importe: 28, fecha: new Date('2026-09-25') } });
  });

  afterAll(async () => {
    await prisma.ingreso.deleteMany({ where: { temporadaId } });
    await prisma.temporada.delete({ where: { id: temporadaId } });
    await cleanupTestEvent(eventId);
  });

  it('rechaza a quien no es admin', async () => {
    sessionRole = 'TAQUILLA';
    expect((await get(`eventId=${eventId}`)).status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('separa online, taquilla tarjeta y taquilla efectivo por día', async () => {
    const res = await get(`eventId=${eventId}&from=2026-09-25&to=2026-09-26`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.dias).toHaveLength(2);
    const d1 = data.dias[0];
    expect(d1.fecha).toBe('2026-09-25');
    expect(d1.online).toEqual({ importe: 20, entradas: 2, pedidos: 1 });
    expect(d1.taquillaEfectivo).toEqual({ importe: 30, entradas: 3, pedidos: 1 });
    expect(d1.taquillaTarjeta).toEqual({ importe: 10, entradas: 1, pedidos: 1 });
    expect(data.totales.total).toEqual({ importe: 100, entradas: 10, pedidos: 4 });
    // Con filtro de evento la caja no es comparable.
    expect(data.cajaComparable).toBe(false);
    expect(d1.cajaEntradas).toBeNull();
  });

  it('un solo día: from = to', async () => {
    const data = await (await get(`eventId=${eventId}&from=2026-09-26&to=2026-09-26`)).json();
    expect(data.dias).toHaveLength(1);
    expect(data.totales.online.importe).toBe(40);
  });

  it('sin filtro de evento compara la caja de Ingresos con el efectivo de taquilla', async () => {
    const data = await (await get('from=2026-09-25&to=2026-09-25')).json();
    expect(data.cajaComparable).toBe(true);
    const dia = data.dias.find((d: { fecha: string }) => d.fecha === '2026-09-25');
    expect(dia.cajaEntradas).toBeGreaterThanOrEqual(28);
  });

  it('devuelve 400 con fechas mal formadas o invertidas', async () => {
    expect((await get('from=25-09-2026')).status).toBe(400);
    expect((await get('from=2026-09-26&to=2026-09-25')).status).toBe(400);
  });
});
