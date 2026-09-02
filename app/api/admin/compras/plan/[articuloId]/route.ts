export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const putPlanSchema = z.object({
  temporadaId: z.string().min(1),
  proveedorElegidoId: z.string().optional().nullable(),
  cantidadPlanificada: z.coerce.number().optional(),
  observaciones: z.string().optional().nullable(),
});

export async function PUT(request: Request, { params }: { params: { articuloId: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = putPlanSchema.parse(await request.json());
    const articuloId = params?.articuloId;

    const plan = await prisma.planCompra.upsert({
      where: { temporadaId_articuloId: { temporadaId: body.temporadaId, articuloId } },
      create: {
        temporadaId: body.temporadaId,
        articuloId,
        proveedorElegidoId: body.proveedorElegidoId || null,
        cantidadPlanificada: body.cantidadPlanificada ?? 0,
        observaciones: body.observaciones || null,
      },
      update: {
        ...(body.proveedorElegidoId !== undefined && { proveedorElegidoId: body.proveedorElegidoId || null }),
        ...(body.cantidadPlanificada !== undefined && { cantidadPlanificada: body.cantidadPlanificada }),
        ...(body.observaciones !== undefined && { observaciones: body.observaciones || null }),
      },
    });
    return NextResponse.json(plan);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/compras/plan/[articuloId]');
  }
}
