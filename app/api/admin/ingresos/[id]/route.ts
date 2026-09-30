export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateIngresoSchema = z.object({
  concepto: z.string().min(1).optional(),
  importe: z.coerce.number().optional(),
  fecha: z.string().optional(),
  notas: z.string().optional().nullable(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateIngresoSchema.parse(await request.json());
    const data: Prisma.IngresoUpdateInput = {};
    if (body.concepto !== undefined) data.concepto = body.concepto;
    if (body.importe !== undefined) data.importe = body.importe;
    if (body.fecha !== undefined) data.fecha = new Date(body.fecha);
    if (body.notas !== undefined) data.notas = body.notas || null;

    const ingreso = await prisma.ingreso.update({ where: { id: params?.id }, data });
    return NextResponse.json(ingreso);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/ingresos/[id]');
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    await prisma.ingreso.delete({ where: { id: params?.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/ingresos/[id]');
  }
}
