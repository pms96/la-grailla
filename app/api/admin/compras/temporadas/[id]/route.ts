export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateTemporadaSchema = z.object({
  nombre: z.string().min(1).optional(),
  anio: z.coerce.number().int().optional(),
  fechaInicio: z.string().optional().nullable(),
  fechaFin: z.string().optional().nullable(),
  status: z.enum(['ABIERTA', 'CERRADA']).optional(),
  notas: z.string().optional().nullable(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateTemporadaSchema.parse(await request.json());
    const data: Prisma.TemporadaUpdateInput = {};
    if (body.nombre !== undefined) data.nombre = body.nombre;
    if (body.anio !== undefined) data.anio = body.anio;
    if (body.fechaInicio !== undefined) data.fechaInicio = body.fechaInicio ? new Date(body.fechaInicio) : null;
    if (body.fechaFin !== undefined) data.fechaFin = body.fechaFin ? new Date(body.fechaFin) : null;
    if (body.status !== undefined) data.status = body.status;
    if (body.notas !== undefined) data.notas = body.notas || null;

    const temporada = await prisma.temporada.update({ where: { id: params?.id }, data });
    return NextResponse.json(temporada);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/compras/temporadas/[id]');
  }
}
