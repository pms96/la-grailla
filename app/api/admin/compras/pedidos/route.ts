export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import type { PedidoStatus } from '@prisma/client';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const temporadaId = searchParams.get('temporadaId');
    const status = searchParams.get('status') as PedidoStatus | null;

    const pedidos = await prisma.pedido.findMany({
      where: {
        ...(temporadaId && { temporadaId }),
        ...(status && { status }),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        proveedor: true,
        temporada: true,
        lineas: { include: { articulo: true } },
        gasto: true,
      },
    });
    return NextResponse.json(pedidos ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/pedidos');
  }
}
