import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-compras-validation', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: crearArticulo } = await import('@/app/api/admin/compras/articulos/route');
const { PATCH: editarArticulo } = await import('@/app/api/admin/compras/articulos/[id]/route');
const { PUT: putPlan } = await import('@/app/api/admin/compras/plan/[articuloId]/route');

/* H-233: Contabilidad endureció gastos e ingresos (`importeSchema`, `ivaPercentSchema`: vacío ≠ 0, rango, tope de Decimal(10,2)) pero Compras seguía con `z.coerce.number()` a secas: `""` o `null`
 * pasaban a 0 (un artículo con IVA vacío quedaba al 0 %), «210» por «21,0» o un precio negativo se guardaban, y un precio enorme daba un 500. Esos valores alimentan «generar pedidos», el
 * planificador y el IVA con el que se pre-rellena el gasto. */

const json = (body: unknown) => new Request('http://localhost/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const nombre = `[TEST] Artículo validación ${Date.now()}`;
const articuloOk = { nombre, categoria: 'Otros', formato: 'Unidad', unidadesPorCaja: 1, ivaPercent: 21 };

describe('Compras: validación de importes, IVA y cantidades (H-233)', () => {
  let proveedorId: string;
  let articuloId: string;
  let temporadaId: string;

  beforeAll(async () => {
    proveedorId = (await prisma.proveedor.create({ data: { nombre: `[TEST] Prov validación ${Date.now()}` } })).id;
    articuloId = (await prisma.articulo.create({ data: { nombre: `${nombre} base`, categoria: 'Otros', formato: 'Unidad' } })).id;
    temporadaId = (await prisma.temporada.create({ data: { nombre: '[TEST] Temp validación', anio: 2098 } })).id;
  });
  afterAll(async () => {
    await prisma.planCompra.deleteMany({ where: { temporadaId } });
    await prisma.precioArticulo.deleteMany({ where: { OR: [{ articuloId }, { articulo: { nombre: { startsWith: '[TEST] Artículo validación' } } }] } });
    await prisma.articulo.deleteMany({ where: { nombre: { startsWith: '[TEST] Artículo validación' } } });
    await prisma.proveedor.deleteMany({ where: { id: proveedorId } });
    await prisma.temporada.deleteMany({ where: { id: temporadaId } });
  });

  const existe = () => prisma.articulo.count({ where: { nombre } });
  const precio = (precioSinIva: unknown) => ({ proveedorId, precioSinIva, formatoVenta: 'Unidad' });

  it.each([
    ['IVA vacío', { ivaPercent: '' }],
    ['IVA nulo', { ivaPercent: null }],
    ['IVA de 210 (un «21,0» mal escrito)', { ivaPercent: 210 }],
    ['IVA negativo', { ivaPercent: -5 }],
    ['IVA que no es un número', { ivaPercent: 'abc' }],
    ['precio vacío', { precios: [precio('')] }],
    ['precio nulo', { precios: [precio(null)] }],
    ['precio negativo', { precios: [precio(-3)] }],
    ['precio más grande de lo que cabe en la columna', { precios: [precio(1e12)] }],
  ])('crear un artículo con %s da 400 y no lo guarda', async (_label, over) => {
    const res = await crearArticulo(json({ ...articuloOk, ...over }));
    expect(res.status).toBe(400);
    expect(await existe()).toBe(0);
  });

  it('un artículo normal sigue funcionando (IVA 0 escrito a propósito, precio 0 y sin IVA = 21 por defecto)', async () => {
    const res = await crearArticulo(json({ nombre, categoria: 'Otros', formato: 'Unidad', precios: [precio(0)] }));
    expect(res.status).toBe(200);
    const creado = await res.json();
    expect(creado.ivaPercent).toBe(21);
    const exento = await editarArticulo(json({ ivaPercent: 0, precios: [precio(2.5)] }), { params: Promise.resolve({ id: creado.id }) });
    expect(exento.status).toBe(200);
    expect((await exento.json()).ivaPercent).toBe(0);
  });

  it('editar: el mismo IVA fuera de rango, vacío o un precio negativo se rechazan y no cambian nada', async () => {
    const antes = await prisma.articulo.findUniqueOrThrow({ where: { id: articuloId } });
    for (const body of [{ ivaPercent: 210 }, { ivaPercent: '' }, { precios: [precio(-1)] }]) {
      const res = await editarArticulo(json(body), { params: Promise.resolve({ id: articuloId }) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const despues = await prisma.articulo.findUniqueOrThrow({ where: { id: articuloId } });
    expect(despues.ivaPercent).toBe(antes.ivaPercent);
  });

  it('planificador: una cantidad negativa, vacía o desproporcionada se rechaza; una normal y el 0 sí', async () => {
    const put = (cantidadPlanificada: unknown) => putPlan(json({ temporadaId, cantidadPlanificada }), { params: Promise.resolve({ articuloId }) });
    for (const mala of [-1, '', null, 1e12]) expect((await put(mala)).status, String(mala)).toBe(400);
    expect((await put(12)).status).toBe(200);
    expect((await put(0)).status).toBe(200);
  });
});
