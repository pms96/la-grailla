export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getPedidosParaExport } from '@/lib/compras/pedidos-data';
import { buildPedidosExcel } from '@/lib/compras/pedidos-excel';
import { buildPedidosPdf } from '@/lib/compras/pedidos-pdf';

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

    const data = await getPedidosParaExport(temporadaId);
    if (!data) {
      return NextResponse.json({ error: 'Temporada no encontrada' }, { status: 404 });
    }
    if (data.pedidos.length === 0) {
      return NextResponse.json({ error: 'Esta temporada no tiene pedidos generados todavía' }, { status: 400 });
    }
    const slug = data.temporada.anio;

    if (format === 'excel') {
      const buffer = await buildPedidosExcel(data);
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="pedidos-${slug}.xlsx"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const pdfBytes = await buildPedidosPdf(data);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="pedidos-${slug}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/pedidos/export');
  }
}
