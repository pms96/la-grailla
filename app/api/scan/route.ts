export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { checkCapacityAlerts } from '@/lib/capacity-alerts';
import { handleApiError } from '@/lib/api-error';

const scanTicketSchema = z.object({
  qrCode: z.string().min(1),
  eventId: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const limit = await rateLimit('scan', getClientIp(request), 120, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiadas peticiones. Espera unos segundos.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const session = await getServerSession(authOptions);
    if (!session?.user || !['ADMIN', 'TAQUILLA'].includes(session.user?.role ?? '')) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const { qrCode, eventId } = scanTicketSchema.parse(await request.json());

    const ticket = await prisma.ticket.findUnique({
      where: { qrCode },
      include: {
        event: true,
        order: true,
        ticketType: true,
      },
    });

    if (!ticket) {
      return NextResponse.json({
        result: 'INVALID',
        message: 'C\u00f3digo QR no reconocido',
        color: 'red',
      });
    }

    // Check if cancelled/refunded
    if (ticket.status === 'CANCELLED' || ticket.status === 'REFUNDED') {
      await prisma.scanLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannerId: session.user?.id,
          result: 'CANCELLED',
        },
      });
      return NextResponse.json({
        result: 'CANCELLED',
        message: 'ENTRADA NO V\u00c1LIDA \u2014 Anulada/Reembolsada',
        color: 'red',
      });
    }

    // Pago todav\u00eda no confirmado por la pasarela: no dejar pasar.
    if (ticket.status === 'PENDING') {
      await prisma.scanLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannerId: session.user?.id,
          result: 'PENDING_PAYMENT',
        },
      });
      return NextResponse.json({
        result: 'PENDING_PAYMENT',
        message: 'PAGO NO CONFIRMADO \u2014 Entrada no v\u00e1lida todav\u00eda',
        color: 'red',
      });
    }

    // Check if for another event
    if (eventId && ticket.eventId !== eventId) {
      await prisma.scanLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannerId: session.user?.id,
          result: 'WRONG_EVENT',
        },
      });
      return NextResponse.json({
        result: 'WRONG_EVENT',
        message: `ENTRADA PARA OTRO EVENTO \u2014 ${ticket.event?.name ?? 'Desconocido'}`,
        eventName: ticket.event?.name,
        eventDate: ticket.event?.date,
        color: 'yellow',
      });
    }

    // Check if already used
    if (ticket.status === 'USED') {
      await prisma.scanLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannerId: session.user?.id,
          result: 'DUPLICATE',
        },
      });
      return NextResponse.json({
        result: 'DUPLICATE',
        message: `YA ENTR\u00d3 \u2014 Hora de entrada: ${ticket.entryTime ? new Date(ticket.entryTime).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : 'N/A'}`,
        entryTime: ticket.entryTime,
        color: 'red',
      });
    }

    // Valid ticket — mark as used
    await prisma.$transaction([
      prisma.ticket.update({
        where: { id: ticket.id },
        data: { status: 'USED', entryTime: new Date() },
      }),
      prisma.event.update({
        where: { id: ticket.eventId },
        data: { currentCount: { increment: 1 } },
      }),
      prisma.scanLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannerId: session.user?.id,
          result: 'VALID',
        },
      }),
    ]);

    void checkCapacityAlerts(ticket.eventId);

    return NextResponse.json({
      result: 'VALID',
      message: `ACCESO PERMITIDO \u2014 ${ticket.holderName ?? 'Invitado'}`,
      holderName: ticket.holderName,
      ticketType: ticket.ticketType?.name,
      color: 'green',
    });
  } catch (error) {
    return handleApiError(error, 'POST /api/scan');
  }
}
