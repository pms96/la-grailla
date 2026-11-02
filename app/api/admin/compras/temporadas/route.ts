export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { actorFromSession, recordAdminAudit } from '@/lib/admin-audit';
import { fechaDiaSchema, parseFechaDia } from '@/lib/contabilidad/validation';

// Vacío o nulo = sin fecha; si viene, un día válido.
const diaOpcional = z.union([z.literal(''), fechaDiaSchema]).optional().nullable();

const createTemporadaSchema = z.object({
  nombre: z.string().min(1),
  anio: z.coerce.number().int(),
  // H-246: días contables (`YYYY-MM-DD`) validados como en gastos e ingresos; antes `new Date(texto)` sin mirar: «abc» daba un 500 y una fecha con hora se guardaba fuera de medianoche UTC.
  fechaInicio: diaOpcional,
  fechaFin: diaOpcional,
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
    // H-018/H-021: la temporada y su rastro se escriben juntos.
    const temporada = await prisma.$transaction(async (tx) => {
      const created = await tx.temporada.create({
        data: {
          nombre: body.nombre,
          anio: body.anio,
          fechaInicio: body.fechaInicio ? parseFechaDia(body.fechaInicio) : null,
          fechaFin: body.fechaFin ? parseFechaDia(body.fechaFin) : null,
          notas: body.notas || null,
        },
      });
      await recordAdminAudit(tx, actorFromSession(session), request, { action: 'temporada.create', targetType: 'Temporada', targetId: created.id, meta: { nombre: created.nombre, anio: created.anio } });
      return created;
    });
    return NextResponse.json(temporada);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/compras/temporadas');
  }
}
