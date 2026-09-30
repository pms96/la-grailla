import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-ingresos-resumen-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: getResumen } = await import('@/app/api/admin/ingresos/resumen/route');

// AUDIT: el balance de la caseta ("lo que queda al final") debe salir de la
// caja manual (Ingreso) menos los Gastos ya registrados de la misma
// temporada — a propósito NUNCA debe mezclarse con las ventas de entradas
// online ni con patrocinios, que se ven aparte en /admin/estadísticas.
describe('GET /api/admin/ingresos/resumen', () => {
  let temporadaId: string;

  beforeAll(async () => {
    const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada balance', anio: 2099 } });
    temporadaId = temporada.id;

    await prisma.ingreso.createMany({
      data: [
        { temporadaId, concepto: 'Entradas', importe: 300, fecha: new Date('2026-09-25') },
        { temporadaId, concepto: 'Barra', importe: 150, fecha: new Date('2026-09-25') },
        { temporadaId, concepto: 'Entradas', importe: 400, fecha: new Date('2026-09-26') },
      ],
    });
    await prisma.gasto.create({
      data: { temporadaId, categoria: 'Bebidas y bar', concepto: '[TEST] compra bebida', importeSinIva: 200, ivaPercent: 0, fecha: new Date('2026-09-24') },
    });
  });

  afterAll(async () => {
    await prisma.ingreso.deleteMany({ where: { temporadaId } });
    await prisma.gasto.deleteMany({ where: { temporadaId } });
    await prisma.temporada.delete({ where: { id: temporadaId } });
  });

  it('suma la caja de todos los días y agrupa por día/concepto', async () => {
    const res = await getResumen(new Request(`http://localhost?temporadaId=${temporadaId}`));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ingresoTotal).toBe(850);
    expect(data.gastoTotal).toBe(200);
    expect(data.balance).toBe(650);
    expect(data.porDia).toHaveLength(2);

    const dia1 = data.porDia.find((d: { fecha: string }) => d.fecha === '2026-09-25');
    expect(dia1.total).toBe(450);
    expect(dia1.lineas).toEqual(expect.arrayContaining([
      { concepto: 'Entradas', total: 300 },
      { concepto: 'Barra', total: 150 },
    ]));

    const dia2 = data.porDia.find((d: { fecha: string }) => d.fecha === '2026-09-26');
    expect(dia2.total).toBe(400);
  });

  it('devuelve 404 si la temporada no existe', async () => {
    const res = await getResumen(new Request('http://localhost?temporadaId=no-existe'));
    expect(res.status).toBe(404);
  });

  it('devuelve 400 si falta temporadaId', async () => {
    const res = await getResumen(new Request('http://localhost'));
    expect(res.status).toBe(400);
  });
});
