export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { madridDayKey } from '@/lib/ventas-por-dia';
import { buildOrdersWhere } from '@/lib/order-filters';
import { actorFromSession, exportFilterForAudit, recordAdminAudit } from '@/lib/admin-audit';
import { ORDERS_CSV_MAX, TICKETS_CSV_MAX, attendeesToCsv, ordersToCsv } from '@/lib/orders-csv';

function csvResponse(filename: string, body: string) {
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get('type') ?? 'orders';
    const eventId = url.searchParams.get('eventId') ?? '';
    const day = madridDayKey(new Date()); // día de Madrid, no UTC: pasada la medianoche el fichero llevaba la fecha de ayer

    if (type === 'orders') {
      // Mismos filtros que /api/admin/orders (lista en pantalla) para que
      // el CSV descargado sea exactamente lo que el admin está viendo
      // filtrado, no todos los pedidos completados del evento.
      const filtro = {
        q: url.searchParams.get('q') ?? '',
        // Sin estado = todos, igual que el listado en pantalla con el filtro «Todos» (H-137). Antes el servidor ponía COMPLETED y el CSV no era lo que se veía.
        status: url.searchParams.get('status') ?? '',
        eventId,
        emailFailed: url.searchParams.get('emailFailed') === '1',
      };
      const where = buildOrdersWhere(filtro);
      // Sin truncado silencioso (H-137): si no cabe, se avisa y se pide filtrar. Antes cortaba a 5000 por el final y se perdían los pedidos más antiguos.
      const totalOrders = await prisma.order.count({ where });
      if (totalOrders > ORDERS_CSV_MAX) {
        return NextResponse.json(
          { error: `Hay ${totalOrders} pedidos con este filtro y el máximo por exportación es ${ORDERS_CSV_MAX}. Filtra por evento, estado o búsqueda y vuelve a exportar.` },
          { status: 413 }
        );
      }
      const orders = await prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          event: { select: { name: true } },
          _count: { select: { tickets: true } },
        },
      });
      // H-145: sale una lista de compradores con nombre y email: queda quién, cuándo, con qué filtro y cuántas filas, SIN los datos. Va ANTES de entregar el
      // fichero y sin «mejor esfuerzo»: si el rastro no se puede escribir, no se exporta.
      await recordAdminAudit(prisma, actorFromSession(session), request, {
        action: 'export.orders',
        targetType: eventId ? 'Event' : 'Order',
        targetId: eventId || null,
        meta: { filtro: exportFilterForAudit(filtro), filas: orders.length },
      });
      const csv = ordersToCsv(orders);
      const name = eventId ? `ventas-${eventId.slice(0, 8)}-${day}.csv` : `ventas-${day}.csv`;
      return csvResponse(name, csv);
    }

    if (type === 'tickets') {
      if (!eventId) {
        return NextResponse.json({ error: 'eventId requerido para exportar asistentes' }, { status: 400 });
      }
      const ticketsWhere = { eventId, status: { notIn: ['CANCELLED', 'REFUNDED'] } } satisfies Prisma.TicketWhereInput;
      const totalTickets = await prisma.ticket.count({ where: ticketsWhere });
      if (totalTickets > TICKETS_CSV_MAX) {
        return NextResponse.json(
          { error: `Hay ${totalTickets} entradas en este evento y el máximo por exportación es ${TICKETS_CSV_MAX}. Contacta con soporte para una exportación completa.` },
          { status: 413 }
        );
      }
      const tickets = await prisma.ticket.findMany({
        where: ticketsWhere,
        orderBy: { createdAt: 'asc' },
        include: {
          ticketType: { select: { name: true } },
          order: {
            select: {
              id: true,
              buyerName: true,
              buyerLastName: true,
              buyerEmail: true,
              channel: true,
              status: true,
            },
          },
          event: { select: { name: true } },
        },
      });
      await recordAdminAudit(prisma, actorFromSession(session), request, {
        action: 'export.attendees',
        targetType: 'Event',
        targetId: eventId,
        meta: { filtro: { eventId }, filas: tickets.length },
      });
      const csv = attendeesToCsv(tickets);
      return csvResponse(`asistentes-${eventId.slice(0, 8)}-${day}.csv`, csv);
    }

    return NextResponse.json({ error: 'type debe ser orders o tickets' }, { status: 400 });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/export');
  }
}
