export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { syncPreciosArticulo } from '@/lib/compras/precios-articulo';

const precioSchema = z.object({
  proveedorId: z.string().min(1),
  precioSinIva: z.coerce.number(),
  descuentoPercent: z.coerce.number().min(0).max(100).default(0),
  formatoVenta: z.string().min(1),
  unidadMinPedido: z.coerce.number().int().min(1).default(1),
  notas: z.string().optional().nullable(),
});

const createArticuloSchema = z.object({
  nombre: z.string().min(1),
  categoria: z.string().min(1),
  formato: z.string().min(1),
  unidadesPorCaja: z.coerce.number().int().min(1).default(1),
  ivaPercent: z.coerce.number().default(21),
  activo: z.boolean().optional(),
  precios: z.array(precioSchema).optional(),
});

const articuloInclude = {
  precios: { include: { proveedor: true }, orderBy: { proveedor: { nombre: 'asc' as const } } },
};

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const articulos = await prisma.articulo.findMany({
      orderBy: [{ categoria: 'asc' }, { nombre: 'asc' }],
      include: articuloInclude,
    });
    return NextResponse.json(articulos ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/articulos');
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = createArticuloSchema.parse(await request.json());
    const articulo = await prisma.$transaction(async (tx) => {
      const created = await tx.articulo.create({
        data: {
          nombre: body.nombre,
          categoria: body.categoria,
          formato: body.formato,
          unidadesPorCaja: body.unidadesPorCaja,
          ivaPercent: body.ivaPercent,
          activo: body.activo ?? true,
        },
      });
      await syncPreciosArticulo(tx, created.id, body.precios);
      return tx.articulo.findUniqueOrThrow({ where: { id: created.id }, include: articuloInclude });
    });
    return NextResponse.json(articulo);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/compras/articulos');
  }
}
