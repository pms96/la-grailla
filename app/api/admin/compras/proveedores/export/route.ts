export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { buildProveedoresExcel } from '@/lib/compras/proveedores-excel';
import { buildProveedoresPdf } from '@/lib/compras/proveedores-pdf';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format');
    if (format !== 'excel' && format !== 'pdf') {
      return NextResponse.json({ error: 'format debe ser excel o pdf' }, { status: 400 });
    }

    const proveedores = await prisma.proveedor.findMany({ orderBy: { nombre: 'asc' } });

    if (format === 'excel') {
      const buffer = await buildProveedoresExcel(proveedores);
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="proveedores.xlsx"',
          'Cache-Control': 'no-store',
        },
      });
    }

    const pdfBytes = await buildProveedoresPdf(proveedores);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="proveedores.pdf"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/proveedores/export');
  }
}
