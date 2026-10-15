export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { buildGoogleWalletSaveUrl } from '@/lib/wallet';
import { handleApiError } from '@/lib/api-error';
import { allowTicketAccess, getTokenFromRequest } from '@/lib/access-token';
import { isModuleEnabled } from '@/lib/modules/runtime';

export async function GET(request: Request, { params }: { params: { ticketId: string } }) {
  try {
    // El pase es de una entrada: sin Entradas no se consulta ni se delata si existe.
    if (!isModuleEnabled('entradas')) {
      return NextResponse.json({ error: 'Entrada no encontrada' }, { status: 404 });
    }
    const ticketId = params?.ticketId;
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { event: true, ticketType: true },
    });
    if (!ticket || !ticket.event) {
      return NextResponse.json({ error: 'Entrada no encontrada' }, { status: 404 });
    }

    if (!(await allowTicketAccess(ticketId, ticket.orderId, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const url = await buildGoogleWalletSaveUrl({
      ticketId: ticket.id,
      eventId: ticket.eventId,
      qrCode: ticket.qrCode,
      holderName: ticket.holderName,
      eventName: ticket.event.name,
      venue: ticket.event.venue,
      city: ticket.event.city,
      date: ticket.event.date,
      ticketTypeName: ticket.ticketType?.name ?? 'General',
      eventImageUrl: ticket.event.imageUrl,
    });

    if (!url) {
      return NextResponse.json({ error: 'Google Wallet no esta configurado' }, { status: 503 });
    }
    return NextResponse.redirect(url);
  } catch (error) {
    return handleApiError(error, 'GET /api/wallet/google/[ticketId]');
  }
}
