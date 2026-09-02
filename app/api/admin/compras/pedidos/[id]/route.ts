export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const pedidoInclude = {
  proveedor: true,
  temporada: true,
  lineas: { include: { articulo: true } },
  gasto: true,
};

// Solo se puede avanzar el pedido hacia adelante, nunca saltarse un paso ni retroceder.
const TRANSICIONES: Record<string, string> = {
  BORRADOR: 'ENVIADO',
  ENVIADO: 'RECIBIDO',
};

const updatePedidoSchema = z.object({
  status: z.enum(['ENVIADO', 'RECIBIDO']),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const pedido = await prisma.pedido.findUnique({ where: { id: params?.id }, include: pedidoInclude });
    if (!pedido) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    return NextResponse.json(pedido);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/pedidos/[id]');
  }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const { status: nuevoStatus } = updatePedidoSchema.parse(await request.json());
    const pedidoId = params?.id;

    const actual = await prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!actual) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });

    const estadoRequerido = Object.keys(TRANSICIONES).find((from) => TRANSICIONES[from] === nuevoStatus);
    if (!estadoRequerido) {
      return NextResponse.json({ error: 'Transición de estado no válida' }, { status: 400 });
    }

    const claim = await prisma.pedido.updateMany({
      where: { id: pedidoId, status: estadoRequerido as never },
      data: {
        status: nuevoStatus,
        ...(nuevoStatus === 'ENVIADO' && { fechaEnviado: new Date() }),
        ...(nuevoStatus === 'RECIBIDO' && { fechaRecibido: new Date() }),
      },
    });
    if (claim.count === 0) {
      return NextResponse.json({ error: `El pedido ya no está en estado ${estadoRequerido}` }, { status: 409 });
    }

    const pedido = await prisma.pedido.findUnique({ where: { id: pedidoId }, include: pedidoInclude });
    return NextResponse.json(pedido);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/compras/pedidos/[id]');
  }
}
