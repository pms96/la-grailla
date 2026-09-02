import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-gastos-resumen-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: getResumen } = await import('@/app/api/admin/gastos/resumen/route');

async function crearOrder(eventId: string, totalAmount: number, status: 'COMPLETED' | 'CANCELLED' | 'PENDING' | 'REFUNDED') {
  return prisma.order.create({
    data: { eventId, buyerName: 'Test', buyerLastName: 'Resumen', buyerEmail: `resumen-${Date.now()}-${Math.random()}@example.com`, totalAmount, status },
  });
}

// Fase 3 del plan de actuación (auditoría UX Pedidos & Gastos): Ingresos y
// Margen en el resumen de Gastos, calculados solo a partir de eventos
// enlazados explícitamente (Fase 2) — nunca por fecha/nombre.
describe('GET /api/admin/gastos/resumen — Ingresos y Margen (Fase 3)', () => {
  let temporada: Awaited<ReturnType<typeof prisma.temporada.create>>;

  beforeAll(async () => {
    temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada resumen', anio: 2097 } });
  });

  afterAll(async () => {
    await prisma.gasto.deleteMany({ where: { temporadaId: temporada.id } });
    await prisma.temporada.delete({ where: { id: temporada.id } }).catch(() => {});
  });

  it('sin eventos enlazados: ingresos 0, margen = -gastoTotal, nEventosEnlazados 0', async () => {
    const gasto = await prisma.gasto.create({
      data: { temporadaId: temporada.id, categoria: 'Otros', concepto: '[TEST] gasto suelto', importeSinIva: 100, ivaPercent: 0 },
    });
    try {
      const res = await getResumen(new Request(`http://localhost?temporadaId=${temporada.id}`));
      const data = await res.json();
      expect(data.nEventosEnlazados).toBe(0);
      expect(data.ingresos).toBe(0);
      expect(data.margen).toBe(-100);
    } finally {
      await prisma.gasto.delete({ where: { id: gasto.id } });
    }
  });

  it('1 evento enlazado: ingresos suma solo los Order COMPLETED de ese evento', async () => {
    const event = await createTestEvent();
    try {
      await prisma.event.update({ where: { id: event.id }, data: { temporadaId: temporada.id } });
      await crearOrder(event.id, 50, 'COMPLETED');
      await crearOrder(event.id, 30, 'COMPLETED');
      await crearOrder(event.id, 999, 'CANCELLED'); // no debe contar

      const res = await getResumen(new Request(`http://localhost?temporadaId=${temporada.id}`));
      const data = await res.json();
      expect(data.nEventosEnlazados).toBe(1);
      expect(data.ingresos).toBe(80);
      expect(data.margen).toBe(80);
    } finally {
      await cleanupTestEvent(event.id);
    }
  });

  it('2 eventos enlazados: suma los ingresos de ambos', async () => {
    const eventA = await createTestEvent();
    const eventB = await createTestEvent();
    try {
      await prisma.event.updateMany({ where: { id: { in: [eventA.id, eventB.id] } }, data: { temporadaId: temporada.id } });
      await crearOrder(eventA.id, 40, 'COMPLETED');
      await crearOrder(eventB.id, 60, 'COMPLETED');
      await crearOrder(eventB.id, 500, 'PENDING'); // no debe contar (no está COMPLETED)

      const res = await getResumen(new Request(`http://localhost?temporadaId=${temporada.id}`));
      const data = await res.json();
      expect(data.nEventosEnlazados).toBe(2);
      expect(data.ingresos).toBe(100);
    } finally {
      await cleanupTestEvent(eventA.id);
      await cleanupTestEvent(eventB.id);
    }
  });
});
