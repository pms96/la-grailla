export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { precioFinalUnidad, proveedorRecomendado } from '@/lib/compras/calculadora';
import { PEDIDO_STATUS_LABEL } from '@/lib/compras/constantes';

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
    type Linea = { articuloId: string; cantidad: number; precioSinIva: number; descuentoPercent: number; ivaPercent: number };
    const porProveedor = new Map<string, Linea[]>();

    for (const plan of planes) {
      const precios = plan.articulo.precios
        .filter((p) => p.proveedor.activo)
        .map((p) => ({
          proveedorId: p.proveedorId,
          proveedorNombre: p.proveedor.nombre,
          precioSinIva: p.precioSinIva,
          descuentoPercent: p.descuentoPercent,
          precioConIva: precioFinalUnidad(p.precioSinIva, p.descuentoPercent, plan.articulo.ivaPercent),
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
        descuentoPercent: precio.descuentoPercent,
        ivaPercent: plan.articulo.ivaPercent,
      });
      porProveedor.set(proveedorId, lineas);
    }

    if (porProveedor.size === 0) {
      return NextResponse.json({ error: 'Ningún artículo planificado tiene un proveedor con precio vigente' }, { status: 400 });
    }

    // Un proveedor puede ya tener un pedido de esta temporada de una
    // generación anterior — un BORRADOR todavía no se ha enviado a nadie, así
    // que es seguro sustituir sus líneas por las cantidades actuales del
    // planificador. Uno ya ENVIADO/RECIBIDO representa un compromiso real y
    // nunca se toca: se deja tal cual y se informa de que se ha omitido.
    const existentes = await prisma.pedido.findMany({
      where: { temporadaId, proveedorId: { in: Array.from(porProveedor.keys()) } },
      include: { proveedor: true },
    });
    const existentePorProveedor = new Map(existentes.map((p) => [p.proveedorId, p]));

    const resultado = await prisma.$transaction(async (tx) => {
      const pedidos = [];
      const omitidos: { proveedorNombre: string; motivo: string }[] = [];

      for (const [proveedorId, lineas] of porProveedor) {
        const existente = existentePorProveedor.get(proveedorId);

        if (existente && existente.status !== 'BORRADOR') {
          omitidos.push({
            proveedorNombre: existente.proveedor.nombre,
            motivo: `ya tiene un pedido en estado "${PEDIDO_STATUS_LABEL[existente.status] ?? existente.status}" — no se ha modificado`,
          });
          continue;
        }

        if (existente) {
          await tx.lineaPedido.deleteMany({ where: { pedidoId: existente.id } });
          const actualizado = await tx.pedido.update({
            where: { id: existente.id },
            data: { fechaPedido: new Date(), lineas: { create: lineas } },
            include: { proveedor: true, lineas: true },
          });
          pedidos.push(actualizado);
        } else {
          const creado = await tx.pedido.create({
            data: { temporadaId, proveedorId, lineas: { create: lineas } },
            include: { proveedor: true, lineas: true },
          });
          pedidos.push(creado);
        }
      }

      return { pedidos, omitidos };
    });

    return NextResponse.json(resultado);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/compras/pedidos/generar');
  }
}
