export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const createIngresoSchema = z.object({
  temporadaId: z.string().min(1),
  concepto: z.string().min(1),
  importe: z.coerce.number(),
  fecha: z.string().optional(),
  notas: z.string().optional().nullable(),
});

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const temporadaId = searchParams.get('temporadaId');

    const ingresos = await prisma.ingreso.findMany({
      where: { ...(temporadaId && { temporadaId }) },
      orderBy: { fecha: 'asc' },
      include: { createdBy: { select: { id: true, name: true, email: true } } },
    });
    return NextResponse.json(ingresos ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/ingresos');
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = createIngresoSchema.parse(await request.json());
    const ingreso = await prisma.ingreso.create({
      data: {
        temporadaId: body.temporadaId,
        concepto: body.concepto,
        importe: body.importe,
        fecha: body.fecha ? new Date(body.fecha) : new Date(),
        notas: body.notas || null,
        createdById: session.user?.id,
      },
    });
    return NextResponse.json(ingreso);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/ingresos');
  }
}
