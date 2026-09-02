export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { syncPreciosArticulo } from '@/lib/compras/precios-articulo';

const precioSchema = z.object({
  proveedorId: z.string().min(1),
  precioSinIva: z.coerce.number(),
  formatoVenta: z.string().min(1),
  unidadMinPedido: z.coerce.number().int().min(1).default(1),
  notas: z.string().optional().nullable(),
});

const updateArticuloSchema = z.object({
  nombre: z.string().min(1).optional(),
  categoria: z.string().min(1).optional(),
  formato: z.string().min(1).optional(),
  unidadesPorCaja: z.coerce.number().int().min(1).optional(),
  ivaPercent: z.coerce.number().optional(),
  activo: z.boolean().optional(),
  precios: z.array(precioSchema).optional(),
});

const articuloInclude = {
  precios: { include: { proveedor: true }, orderBy: { proveedor: { nombre: 'asc' as const } } },
};

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateArticuloSchema.parse(await request.json());
    const articulo = await prisma.$transaction(async (tx) => {
      const data: Prisma.ArticuloUpdateInput = {};
      if (body.nombre !== undefined) data.nombre = body.nombre;
      if (body.categoria !== undefined) data.categoria = body.categoria;
      if (body.formato !== undefined) data.formato = body.formato;
      if (body.unidadesPorCaja !== undefined) data.unidadesPorCaja = body.unidadesPorCaja;
      if (body.ivaPercent !== undefined) data.ivaPercent = body.ivaPercent;
      if (body.activo !== undefined) data.activo = body.activo;

      const updated = await tx.articulo.update({ where: { id: params?.id }, data });
      await syncPreciosArticulo(tx, updated.id, body.precios);
      return tx.articulo.findUniqueOrThrow({ where: { id: updated.id }, include: articuloInclude });
    });
    return NextResponse.json(articulo);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/compras/articulos/[id]');
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    await prisma.articulo.update({ where: { id: params?.id }, data: { activo: false } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/compras/articulos/[id]');
  }
}
