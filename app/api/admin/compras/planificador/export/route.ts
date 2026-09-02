export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getPlanificadorData } from '@/lib/compras/planificador-data';
import { buildPlanificadorExcel } from '@/lib/compras/planificador-excel';
import { buildPlanificadorPdf } from '@/lib/compras/planificador-pdf';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const temporadaId = searchParams.get('temporadaId');
    const format = searchParams.get('format');
    if (!temporadaId) {
      return NextResponse.json({ error: 'Falta temporadaId' }, { status: 400 });
    }
    if (format !== 'excel' && format !== 'pdf') {
      return NextResponse.json({ error: 'format debe ser excel o pdf' }, { status: 400 });
    }

    const data = await getPlanificadorData(temporadaId);
    if (!data) {
      return NextResponse.json({ error: 'Temporada no encontrada' }, { status: 404 });
    }
    const { temporada, temporadaAnterior, filas } = data;
    const slug = temporada.anio;

    if (format === 'excel') {
      const buffer = await buildPlanificadorExcel(temporada, temporadaAnterior, filas);
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="planificador-${slug}.xlsx"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const pdfBytes = await buildPlanificadorPdf(temporada, temporadaAnterior, filas);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="planificador-${slug}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/planificador/export');
  }
}
