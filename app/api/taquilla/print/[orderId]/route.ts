export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { buildTicketsPdfForRoll } from '@/lib/ticket-pdf';
import { handleApiError } from '@/lib/api-error';

export async function GET(
  request: Request,
  { params }: { params: { orderId: string } }
) {
  const session = await getServerSession(authOptions);
  const role = session?.user?.role ?? '';
  if (!session?.user || !['ADMIN', 'TAQUILLA'].includes(role)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const order = await prisma.order.findUnique({
      where: { id: params?.orderId },
      include: { event: true, tickets: { include: { ticketType: true } } },
    });
    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }

    const pdfBytes = await buildTicketsPdfForRoll(order);

    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="entradas-${order.id.slice(0, 8)}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/taquilla/print/[orderId]');
  }
}
