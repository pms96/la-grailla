import { describe, it, expect, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-compras-importar-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: importar } = await import('@/app/api/admin/compras/articulos/importar/route');

async function limpiar(proveedorId: string, articuloIds: string[]) {
  await prisma.precioArticulo.deleteMany({ where: { proveedorId } });
  await prisma.articulo.deleteMany({ where: { id: { in: articuloIds } } });
  await prisma.proveedor.deleteMany({ where: { id: proveedorId } });
}

describe('POST /api/admin/compras/articulos/importar', () => {
  it('crea artículos nuevos y actualiza el precio de uno ya existente para ese proveedor', async () => {
    const proveedor = await prisma.proveedor.create({ data: { nombre: 'Proveedor Importar Test' } });
    const existente = await prisma.articulo.create({ data: { nombre: 'Cruzcampo 1/3 Importar Test', categoria: 'Cervezas', formato: 'Botella 1/3' } });
    const articuloIds = [existente.id];

    try {
      const res = await importar(
        new Request('http://localhost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proveedorId: proveedor.id,
            items: [
              { nombre: existente.nombre, categoria: 'Cervezas', formato: 'Botella 1/3', precioSinIva: 0.55, formatoVenta: 'Caja 24', unidadMinPedido: 24 },
              { nombre: 'Fanta Naranja Importar Test', categoria: 'Refrescos', formato: 'Lata 33cl', precioSinIva: 0.48, formatoVenta: 'Caja 24', unidadMinPedido: 1 },
            ],
          }),
        })
      );
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.creados).toBe(1);
      expect(data.actualizados).toBe(1);
      articuloIds.push(...data.articulos.map((a: { id: string }) => a.id));

      const precioExistente = await prisma.precioArticulo.findUnique({
        where: { articuloId_proveedorId: { articuloId: existente.id, proveedorId: proveedor.id } },
      });
      expect(precioExistente?.precioSinIva).toBe(0.55);

      const nuevo = await prisma.articulo.findFirst({ where: { nombre: 'Fanta Naranja Importar Test' } });
      expect(nuevo).not.toBeNull();
    } finally {
      await limpiar(proveedor.id, Array.from(new Set(articuloIds)));
    }
  });

  it('coincide con un artículo existente sin importar mayúsculas/minúsculas', async () => {
    const proveedor = await prisma.proveedor.create({ data: { nombre: 'Proveedor Importar Case Test' } });
    const existente = await prisma.articulo.create({ data: { nombre: 'Agua Mineral Importar Test', categoria: 'Aguas', formato: 'Botella 50cl' } });

    try {
      const res = await importar(
        new Request('http://localhost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proveedorId: proveedor.id,
            items: [{ nombre: 'agua mineral importar test', categoria: 'Aguas', formato: 'Botella 50cl', precioSinIva: 0.2, formatoVenta: 'Caja 12', unidadMinPedido: 1 }],
          }),
        })
      );
      const data = await res.json();
      expect(data.creados).toBe(0);
      expect(data.actualizados).toBe(1);
      expect(data.articulos[0].id).toBe(existente.id);
    } finally {
      await limpiar(proveedor.id, [existente.id]);
    }
  });

  it('rechaza items vacíos y proveedor inexistente', async () => {
    const resVacio = await importar(
      new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proveedorId: 'irrelevant', items: [] }) })
    );
    expect(resVacio.status).toBe(400);

    const resSinProveedor = await importar(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proveedorId: 'no-existe', items: [{ nombre: 'X', categoria: 'Otros', formato: 'Unidad', precioSinIva: 1, formatoVenta: 'Unidad' }] }),
      })
    );
    expect(resSinProveedor.status).toBe(404);
  });

  it('rechaza a un usuario que no es ADMIN', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({ user: { id: 'u1', role: 'TAQUILLA' } } as never);
    const res = await importar(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proveedorId: 'irrelevant', items: [{ nombre: 'X', categoria: 'Otros', formato: 'Unidad', precioSinIva: 1, formatoVenta: 'Unidad' }] }),
      })
    );
    expect(res.status).toBe(401);
  });
});
