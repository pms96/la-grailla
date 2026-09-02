export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const createTemporadaSchema = z.object({
  nombre: z.string().min(1),
  anio: z.coerce.number().int(),
  fechaInicio: z.string().optional().nullable(),
  fechaFin: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
});

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const incluirArchivadas = searchParams.get('incluirArchivados') === '1';
    const temporadas = await prisma.temporada.findMany({
      where: incluirArchivadas ? undefined : { archivado: false },
      orderBy: { anio: 'desc' },
    });
    return NextResponse.json(temporadas ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/temporadas');
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = createTemporadaSchema.parse(await request.json());
    const temporada = await prisma.temporada.create({
      data: {
        nombre: body.nombre,
        anio: body.anio,
        fechaInicio: body.fechaInicio ? new Date(body.fechaInicio) : null,
        fechaFin: body.fechaFin ? new Date(body.fechaFin) : null,
        notas: body.notas || null,
      },
    });
    return NextResponse.json(temporada);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/compras/temporadas');
  }
}
