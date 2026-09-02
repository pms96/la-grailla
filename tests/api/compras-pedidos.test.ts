import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-compras-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: generar } = await import('@/app/api/admin/compras/pedidos/generar/route');
const { PATCH: patchPedido } = await import('@/app/api/admin/compras/pedidos/[id]/route');
const { PUT: putPlan } = await import('@/app/api/admin/compras/plan/[articuloId]/route');

async function crearEscenario() {
  const temporada = await prisma.temporada.create({ data: { nombre: 'Test Temporada', anio: 2099 } });
  const proveedorBarato = await prisma.proveedor.create({ data: { nombre: 'Proveedor Barato' } });
  const proveedorCaro = await prisma.proveedor.create({ data: { nombre: 'Proveedor Caro' } });
  const articulo = await prisma.articulo.create({ data: { nombre: 'Artículo Test', categoria: 'Otros', formato: 'Unidad' } });
  await prisma.precioArticulo.create({
    data: { articuloId: articulo.id, proveedorId: proveedorBarato.id, precioSinIva: 1, formatoVenta: 'Unidad' },
  });
  await prisma.precioArticulo.create({
    data: { articuloId: articulo.id, proveedorId: proveedorCaro.id, precioSinIva: 5, formatoVenta: 'Unidad' },
  });
  return { temporada, proveedorBarato, proveedorCaro, articulo };
}

async function limpiar(temporadaId: string, proveedorIds: string[], articuloId: string) {
  await prisma.gasto.deleteMany({ where: { temporadaId } });
  await prisma.lineaPedido.deleteMany({ where: { articuloId } });
  await prisma.pedido.deleteMany({ where: { temporadaId } });
  await prisma.planCompra.deleteMany({ where: { temporadaId } });
  await prisma.precioArticulo.deleteMany({ where: { articuloId } });
  await prisma.articulo.deleteMany({ where: { id: articuloId } });
  await prisma.proveedor.deleteMany({ where: { id: { in: proveedorIds } } });
  await prisma.temporada.deleteMany({ where: { id: temporadaId } });
}

describe('POST /api/admin/compras/pedidos/generar', () => {
  it('agrupa por el proveedor más barato cuando no hay override manual', async () => {
    const { temporada, proveedorBarato, proveedorCaro, articulo } = await crearEscenario();
    try {
      await putPlan(
        new Request('http://localhost', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temporadaId: temporada.id, cantidadPlanificada: 10 }) }),
        { params: { articuloId: articulo.id } }
      );

      const res = await generar(
        new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temporadaId: temporada.id }) })
      );
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.pedidos).toHaveLength(1);
      expect(data.pedidos[0].proveedor.id).toBe(proveedorBarato.id);
      expect(data.pedidos[0].lineas[0].cantidad).toBe(10);
      expect(data.pedidos[0].lineas[0].precioSinIva).toBe(1);
    } finally {
      await limpiar(temporada.id, [proveedorBarato.id, proveedorCaro.id], articulo.id);
    }
  });

  it('respeta el proveedor elegido manualmente aunque no sea el más barato', async () => {
    const { temporada, proveedorBarato, proveedorCaro, articulo } = await crearEscenario();
    try {
      await putPlan(
        new Request('http://localhost', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temporadaId: temporada.id, cantidadPlanificada: 4, proveedorElegidoId: proveedorCaro.id }) }),
        { params: { articuloId: articulo.id } }
      );

      const res = await generar(
        new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temporadaId: temporada.id }) })
      );
      const data = await res.json();
      expect(data.pedidos).toHaveLength(1);
      expect(data.pedidos[0].proveedor.id).toBe(proveedorCaro.id);
    } finally {
      await limpiar(temporada.id, [proveedorBarato.id, proveedorCaro.id], articulo.id);
    }
  });
});

describe('PATCH /api/admin/compras/pedidos/[id] — transición de estado', () => {
  it('solo avanza hacia adelante y solo una vez en concurrencia', async () => {
    const { temporada, proveedorBarato, proveedorCaro, articulo } = await crearEscenario();
    try {
      const pedido = await prisma.pedido.create({ data: { temporadaId: temporada.id, proveedorId: proveedorBarato.id } });

      // Dos peticiones "ENVIADO" en paralelo: solo una debe ganar el updateMany condicional.
      const [r1, r2] = await Promise.all([
        patchPedido(new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ENVIADO' }) }), { params: { id: pedido.id } }),
        patchPedido(new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ENVIADO' }) }), { params: { id: pedido.id } }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const actualizado = await prisma.pedido.findUnique({ where: { id: pedido.id } });
      expect(actualizado?.status).toBe('ENVIADO');

      // No se puede saltar de ENVIADO directo a... intentar "ENVIADO" de nuevo debe fallar (ya no está en BORRADOR).
      const resRepetido = await patchPedido(
        new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ENVIADO' }) }),
        { params: { id: pedido.id } }
      );
      expect(resRepetido.status).toBe(409);
    } finally {
      await limpiar(temporada.id, [proveedorBarato.id, proveedorCaro.id], articulo.id);
    }
  });
});

describe('control de rol', () => {
  it('rechaza a un usuario que no es ADMIN', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({ user: { id: 'u1', role: 'TAQUILLA' } } as never);
    const res = await generar(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temporadaId: 'irrelevant' }) }));
    expect(res.status).toBe(401);
  });
});
