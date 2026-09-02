export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { precioConIva, proveedorRecomendado } from '@/lib/compras/calculadora';

const generarPedidosSchema = z.object({ temporadaId: z.string().min(1) });

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { temporadaId } = generarPedidosSchema.parse(await request.json());

    const planes = await prisma.planCompra.findMany({
      where: { temporadaId, cantidadPlanificada: { gt: 0 } },
      include: { articulo: { include: { precios: { include: { proveedor: true } } } } },
    });

    if (planes.length === 0) {
      return NextResponse.json({ error: 'No hay artículos con cantidad planificada para generar pedidos' }, { status: 400 });
    }

    // Agrupa por proveedor resuelto (elegido manualmente, o el recomendado por precio).
    type Linea = { articuloId: string; cantidad: number; precioSinIva: number; ivaPercent: number };
    const porProveedor = new Map<string, Linea[]>();

    for (const plan of planes) {
      const precios = plan.articulo.precios
        .filter((p) => p.proveedor.activo)
        .map((p) => ({
          proveedorId: p.proveedorId,
          proveedorNombre: p.proveedor.nombre,
          precioSinIva: p.precioSinIva,
          precioConIva: precioConIva(p.precioSinIva, plan.articulo.ivaPercent),
        }));
      const recomendado = proveedorRecomendado(precios);
      const proveedorId = plan.proveedorElegidoId ?? recomendado?.proveedorId;
      if (!proveedorId) continue; // sin proveedor con precio, no se puede generar línea

      const precio = precios.find((p) => p.proveedorId === proveedorId);
      if (!precio) continue;

      const lineas = porProveedor.get(proveedorId) ?? [];
      lineas.push({
        articuloId: plan.articuloId,
        cantidad: plan.cantidadPlanificada,
        precioSinIva: precio.precioSinIva,
        ivaPercent: plan.articulo.ivaPercent,
      });
      porProveedor.set(proveedorId, lineas);
    }

    if (porProveedor.size === 0) {
      return NextResponse.json({ error: 'Ningún artículo planificado tiene un proveedor con precio vigente' }, { status: 400 });
    }

    const pedidos = await prisma.$transaction(
      Array.from(porProveedor.entries()).map(([proveedorId, lineas]) =>
        prisma.pedido.create({
          data: {
            temporadaId,
            proveedorId,
            lineas: { create: lineas },
          },
          include: { proveedor: true, lineas: true },
        })
      )
    );

    return NextResponse.json({ pedidos });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/compras/pedidos/generar');
  }
}
