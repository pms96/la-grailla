export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { adminLacksModule } from '@/lib/modules/access';
import { authOptions } from '@/lib/auth';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { checkCapacityAlerts } from '@/lib/capacity-alerts';
import { handleApiError } from '@/lib/api-error';
import { formatMadridTime } from '@/lib/event-time';
import { ticketUnusable } from '@/lib/ticket-validity';

// Se identifica la entrada por su QR (lectura con la cámara) o por su id (admisión MANUAL tras buscar al asistente por nombre/email, P1-06): una
// admisión manual pasa por las MISMAS comprobaciones que un escaneo (anulada, pedido, evento, duplicada) y solo cambia cómo se registra.
const scanTicketSchema = z
  .object({
    qrCode: z.string().min(1).optional(),
    ticketId: z.string().min(1).optional(),
    eventId: z.string().optional(),
  })
  .refine((v) => Boolean(v.qrCode) !== Boolean(v.ticketId), { message: 'Indica qrCode o ticketId' });

// P1-06: antes había UN límite de 120/min por IP, y varias puertas en la wifi del recinto comparten IP: a ~2 lecturas/s agregadas empezaban los 429
// y la puerta se paraba. Ahora el límite fino es POR USUARIO de la sesión (cada puerta/dispositivo el suyo) y el de IP queda como red de seguridad
// muy alta, para cortar a quien inunde la ruta sin sesión.
const SCAN_IP_LIMIT_PER_MIN = 1200;
const SCAN_USER_LIMIT_PER_MIN = 240;

export async function POST(request: Request) {
  try {
    const limit = await rateLimit('scan', getClientIp(request), SCAN_IP_LIMIT_PER_MIN, 60_000);
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
    if (adminLacksModule(session.user, 'entradas')) {
      return NextResponse.json({ error: 'Sin permiso para este módulo' }, { status: 403 });
    }

    const userLimit = await rateLimit('scan-user', session.user.id, SCAN_USER_LIMIT_PER_MIN, 60_000);
    if (!userLimit.ok) {
      return NextResponse.json(
        { error: 'Demasiadas peticiones. Espera unos segundos.' },
        { status: 429, headers: { 'Retry-After': String(userLimit.retryAfter) } }
      );
    }

    const { qrCode, ticketId, eventId } = scanTicketSchema.parse(await request.json());
    const manual = Boolean(ticketId);

    // Sin evento elegido no se valida: una entrada de otro evento (o de otra fecha) se marcaría USED y contaría en el aforo equivocado (EN-13).
    if (!eventId) {
      return NextResponse.json(
        { result: 'NO_EVENT', message: 'ELIGE EL EVENTO — Selecciona el evento en la pantalla antes de escanear', color: 'yellow' },
        { status: 400 }
      );
    }

    const ticket = await prisma.ticket.findUnique({
      where: ticketId ? { id: ticketId } : { qrCode },
      include: {
        event: true,
        order: true,
        ticketType: true,
      },
    });

    if (!ticket) {
      return NextResponse.json({
        result: 'INVALID',
        message: manual ? 'Entrada no encontrada' : 'C\u00f3digo QR no reconocido',
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

    // El estado del PEDIDO y del EVENTO manda sobre el de la entrada: un reembolso hecho fuera de la app, o un proceso que murió a medias al
    // anular, dejan la entrada en VALID con el pedido ya devuelto (P1-02).
    const unusable = ticketUnusable(ticket.order, ticket.event);
    if (unusable && unusable.reason !== 'order_pending') {
      await prisma.scanLog.create({
        data: { ticketId: ticket.id, eventId: ticket.eventId, scannerId: session.user?.id, result: 'CANCELLED' },
      });
      return NextResponse.json({ result: 'CANCELLED', message: unusable.scanMessage, color: 'red' });
    }

    // Pago todav\u00eda no confirmado por la pasarela: no dejar pasar.
    if (ticket.status === 'PENDING' || unusable?.reason === 'order_pending') {
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
        message: `YA ENTR\u00d3 \u2014 Hora de entrada: ${formatMadridTime(ticket.entryTime)}`,
        entryTime: ticket.entryTime,
        color: 'red',
      });
    }

    // Valid ticket — mark as used. El `ticket` de arriba se leyó fuera de esta
    // transacción, así que dos escaneos casi simultáneos del mismo QR pueden
    // llegar los dos hasta aquí viendo status: 'VALID'. Por eso el update va
    // condicionado al estado (WHERE status = VALID, atómico a nivel de fila)
    // en vez de filtrar solo por id — si el otro escaneo ya ganó la carrera,
    // `count` sale 0 y este se trata como DUPLICATE en vez de admitir una
    // segunda entrada y contarla dos veces en el aforo.
    const outcome = await prisma.$transaction(async (tx) => {
      const updated = await tx.ticket.updateMany({
        where: { id: ticket.id, status: 'VALID' },
        data: { status: 'USED', entryTime: new Date() },
      });

      if (updated.count === 0) {
        await tx.scanLog.create({
          data: {
            ticketId: ticket.id,
            eventId: ticket.eventId,
            scannerId: session.user?.id,
            result: 'DUPLICATE',
          },
        });
        return 'DUPLICATE' as const;
      }

      await tx.event.update({
        where: { id: ticket.eventId },
        data: { currentCount: { increment: 1 } },
      });
      await tx.scanLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannerId: session.user?.id,
          result: manual ? 'VALID_MANUAL' : 'VALID',
        },
      });
      return 'VALID' as const;
    });

    if (outcome === 'DUPLICATE') {
      const freshTicket = await prisma.ticket.findUnique({ where: { id: ticket.id } });
      return NextResponse.json({
        result: 'DUPLICATE',
        message: `YA ENTRÓ — Hora de entrada: ${formatMadridTime(freshTicket?.entryTime)}`,
        entryTime: freshTicket?.entryTime,
        color: 'red',
      });
    }

    void checkCapacityAlerts(ticket.eventId);

    return NextResponse.json({
      result: 'VALID',
      message: `ACCESO PERMITIDO \u2014 ${ticket.holderName ?? 'Invitado'}`,
      holderName: ticket.holderName,
      ticketType: ticket.ticketType?.name,
      manual,
      color: 'green',
    });
  } catch (error) {
    return handleApiError(error, 'POST /api/scan');
  }
}
