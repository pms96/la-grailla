export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { buildGoogleWalletSaveUrl } from '@/lib/wallet';
import { handleApiError } from '@/lib/api-error';

export async function GET(request: Request, { params }: { params: { ticketId: string } }) {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: params?.ticketId },
      include: { event: true, ticketType: true },
    });
    if (!ticket || !ticket.event) {
      return NextResponse.json({ error: 'Entrada no encontrada' }, { status: 404 });
    }

    const url = await buildGoogleWalletSaveUrl({
      ticketId: ticket.id,
      qrCode: ticket.qrCode,
      holderName: ticket.holderName,
      eventName: ticket.event.name,
      venue: ticket.event.venue,
      city: ticket.event.city,
      date: ticket.event.date,
      ticketTypeName: ticket.ticketType?.name ?? 'General',
    });

    if (!url) {
      return NextResponse.json({ error: 'Google Wallet no esta configurado' }, { status: 503 });
    }
    return NextResponse.redirect(url);
  } catch (error) {
    return handleApiError(error, 'GET /api/wallet/google/[ticketId]');
  }
}
