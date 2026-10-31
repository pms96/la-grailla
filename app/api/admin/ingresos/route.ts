export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { jornadaHoy } from '@/lib/jornada';
import { checkTemporadaAbierta } from '@/lib/contabilidad/control';
import { actorFromSession, recordAdminAudit } from '@/lib/admin-audit';

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

    // Los ingresos anulados no cuentan en ninguna cifra; solo se listan si se piden (`?anulados=1`).
    const incluirAnulados = searchParams.get('anulados') === '1';

    const ingresos = await prisma.ingreso.findMany({
      where: { ...(incluirAnulados ? {} : { voidedAt: null }), ...(temporadaId && { temporadaId }) },
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
    const open = await checkTemporadaAbierta(body.temporadaId);
    if (!open.ok) return NextResponse.json({ error: open.error, code: open.code }, { status: open.status });
    const fecha = new Date(body.fecha ?? (await jornadaHoy()));
    // El ingreso y su rastro de auditoría se escriben juntos.
    const ingreso = await prisma.$transaction(async (tx) => {
      const created = await tx.ingreso.create({
        data: {
          temporadaId: body.temporadaId,
          concepto: body.concepto,
          importe: body.importe,
          // Sin fecha: la JORNADA actual como medianoche UTC (el formato de las demás filas), no el instante actual (cuyo prefijo UTC podía ser el día anterior).
          fecha,
          notas: body.notas || null,
          createdById: session.user?.id,
        },
      });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'ingreso.create',
        targetType: 'Ingreso',
        targetId: created.id,
        meta: { temporadaId: created.temporadaId, concepto: created.concepto, importe: created.importe, fecha: created.fecha },
      });
      return created;
    });
    return NextResponse.json(ingreso);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/ingresos');
  }
}
