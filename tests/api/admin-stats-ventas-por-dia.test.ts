import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';

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

/* P1-15: el cuadre agrupaba las ventas por día natural y la caja se anota por noche. Con hora de corte, las ventas de la madrugada cuentan en la jornada que
 * empezó la víspera, y el filtro desde/hasta usa la MISMA definición (si no, una venta podía aparecer en un día y quedar fuera del rango de ese día). */
describe('GET /api/admin/stats/ventas-por-dia con hora de corte de la jornada (P1-15)', () => {
  let eventId: string;
  let temporadaId: string;

  beforeAll(async () => {
    eventId = (await createTestEvent()).id;
    temporadaId = (await prisma.temporada.create({ data: { nombre: '[TEST] Temporada jornada', anio: 2095 } })).id;
    const mk = async (createdAt: string, totalAmount: number, tag: string) => {
      const order = await prisma.order.create({
        data: { buyerName: 'T', buyerLastName: 'T', buyerEmail: 'j@example.com', status: 'COMPLETED', eventId, createdAt: new Date(createdAt), totalAmount, channel: 'TAQUILLA', paymentMethod: 'CASH' },
      });
      await prisma.ticket.create({ data: { orderId: order.id, eventId, qrCode: `qr-jornada-${tag}-${order.id}`, holderName: 'T' } });
    };
    // Sábado 31/10/2026 (Madrid en horario de invierno, UTC+1): 22:30, 00:30 de la madrugada y 06:30 (ya es la jornada siguiente con corte a las 06:00).
    await mk('2026-10-31T21:30:00Z', 400, 'a');
    await mk('2026-10-31T23:30:00Z', 200, 'b');
    await mk('2026-11-01T05:30:00Z', 50, 'c');
    await prisma.ingreso.create({ data: { temporadaId, concepto: 'Entradas', importe: 600, fecha: new Date('2026-10-31') } });
  });
  afterAll(async () => {
    await prisma.ingreso.deleteMany({ where: { temporadaId } });
    await prisma.temporada.delete({ where: { id: temporadaId } });
    await cleanupTestEvent(eventId);
  });

  const withCorte = async (corte: string, fn: () => Promise<void>) => {
    const prev = await getAndSetConfig('jornada_corte_hora', corte);
    try {
      await fn();
    } finally {
      await restoreConfig('jornada_corte_hora', prev);
    }
  };
  const day = async (qs: string) => (await (await get(`eventId=${eventId}&${qs}`)).json()) as { dias: { fecha: string; taquillaEfectivo: { importe: number } }[]; totales: { taquillaEfectivo: { importe: number } }; corteHora: number };

  it('sin corte (por defecto): el día natural de siempre; el sábado solo trae lo anterior a la medianoche', async () => {
    await withCorte('0', async () => {
      const sabado = await day('from=2026-10-31&to=2026-10-31');
      expect(sabado.corteHora).toBe(0);
      expect(sabado.dias.map((d) => [d.fecha, d.taquillaEfectivo.importe])).toEqual([['2026-10-31', 400]]);
    });
  });

  it('con corte a las 06:00: la noche entera (22:30 y 00:30) es la jornada del sábado; las 06:30 ya son la del domingo', async () => {
    await withCorte('6', async () => {
      const sabado = await day('from=2026-10-31&to=2026-10-31');
      expect(sabado.corteHora).toBe(6);
      expect(sabado.dias.map((d) => [d.fecha, d.taquillaEfectivo.importe])).toEqual([['2026-10-31', 600]]);
      const domingo = await day('from=2026-11-01&to=2026-11-01');
      expect(domingo.dias.map((d) => [d.fecha, d.taquillaEfectivo.importe])).toEqual([['2026-11-01', 50]]);
      // Sin filtro, cada pedido en su jornada y ninguno repetido ni perdido: los mismos 650 € que sin corte.
      const todo = await day('');
      expect(todo.dias.map((d) => [d.fecha, d.taquillaEfectivo.importe])).toEqual([['2026-10-31', 600], ['2026-11-01', 50]]);
      expect(todo.totales.taquillaEfectivo.importe).toBe(650);
    });
  });

  it('la caja de la noche CUADRA con el corte (sin filtro de evento): 600 € vendidos en efectivo contra 600 € anotados el sábado', async () => {
    await withCorte('6', async () => {
      // La BD de pruebas se comparte: si hubiera pedidos de taquilla en efectivo de OTROS eventos en esa misma jornada, entran en el cálculo esperado.
      const { businessDayStart } = await import('@/lib/ventas-por-dia');
      const others = await prisma.order.aggregate({
        where: {
          status: 'COMPLETED', channel: 'TAQUILLA', paymentMethod: 'CASH', eventId: { not: eventId },
          createdAt: { gte: businessDayStart('2026-10-31', 6), lt: businessDayStart('2026-11-01', 6) },
        },
        _sum: { totalAmount: true },
      });
      const otros = Number(others._sum.totalAmount ?? 0);
      const res = await (await get('from=2026-10-31&to=2026-10-31')).json();
      const sabado = res.dias.find((d: { fecha: string }) => d.fecha === '2026-10-31');
      expect(sabado.taquillaEfectivo.importe).toBe(Math.round((600 + otros) * 100) / 100);
      expect(sabado.cajaEntradas).toBe(600);
      expect(sabado.diferenciaCaja).toBe(Math.round((600 - (600 + otros)) * 100) / 100); // 0 cuando solo están los pedidos de esta prueba
    });
  });
});
