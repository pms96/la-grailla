export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const itemSchema = z.object({
  nombre: z.string().min(1),
  categoria: z.string().min(1),
  formato: z.string().min(1),
  precioSinIva: z.coerce.number().min(0),
  formatoVenta: z.string().min(1),
  unidadMinPedido: z.coerce.number().int().min(1).default(1),
});

const importarSchema = z.object({
  proveedorId: z.string().min(1),
  items: z.array(itemSchema).min(1),
});

const articuloInclude = {
  precios: { include: { proveedor: true }, orderBy: { proveedor: { nombre: 'asc' as const } } },
};

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { proveedorId, items } = importarSchema.parse(await request.json());

    const proveedor = await prisma.proveedor.findUnique({ where: { id: proveedorId } });
    if (!proveedor) {
      return NextResponse.json({ error: 'Proveedor no encontrado' }, { status: 404 });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      let creados = 0;
      let actualizados = 0;
      const articulos = [];

      for (const item of items) {
        const existente = await tx.articulo.findFirst({
          where: { nombre: { equals: item.nombre, mode: 'insensitive' } },
        });

        const articuloId = existente
          ? existente.id
          : (
              await tx.articulo.create({
                data: { nombre: item.nombre, categoria: item.categoria, formato: item.formato, activo: true },
              })
            ).id;

        if (existente) actualizados += 1;
        else creados += 1;

        await tx.precioArticulo.upsert({
          where: { articuloId_proveedorId: { articuloId, proveedorId } },
          create: {
            articuloId,
            proveedorId,
            precioSinIva: item.precioSinIva,
            formatoVenta: item.formatoVenta,
            unidadMinPedido: item.unidadMinPedido,
          },
          update: {
            precioSinIva: item.precioSinIva,
            formatoVenta: item.formatoVenta,
            unidadMinPedido: item.unidadMinPedido,
          },
        });

        articulos.push(await tx.articulo.findUniqueOrThrow({ where: { id: articuloId }, include: articuloInclude }));
      }

      return { creados, actualizados, articulos };
    });

    return NextResponse.json(resultado);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/compras/articulos/importar');
  }
}
