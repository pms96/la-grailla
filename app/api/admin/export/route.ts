export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

// Si una celda empieza por =, +, -, @, tab o retorno de carro, Excel/Sheets
// la puede interpretar como fórmula al abrir el CSV — y estas celdas vienen
// de datos escritos por compradores (nombre, etc.), no de nadie de
// confianza. Anteponer un apóstrofo neutraliza la fórmula sin cambiar lo
// que ve quien abre el archivo.
function csvEscape(value: unknown): string {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => row.map(csvEscape).join(',')),
  ];
  return '\uFEFF' + lines.join('\n');
}

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
    const day = new Date().toISOString().slice(0, 10);

    if (type === 'orders') {
      const where: Prisma.OrderWhereInput = {
        status: 'COMPLETED',
        ...(eventId ? { eventId } : {}),
      };
      const orders = await prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 5000,
        include: {
          event: { select: { name: true } },
          _count: { select: { tickets: true } },
        },
      });
      const csv = toCsv(
        [
          'id',
          'fecha',
          'evento',
          'nombre',
          'apellidos',
          'email',
          'canal',
          'metodo_pago',
          'entradas',
          'importe',
          'comision',
        ],
        orders.map((o) => [
          o.id,
          o.createdAt.toISOString(),
          o.event?.name ?? '',
          o.buyerName,
          o.buyerLastName,
          o.buyerEmail,
          o.channel,
          o.paymentMethod,
          o._count.tickets,
          o.totalAmount.toFixed(2),
          o.commission.toFixed(2),
        ])
      );
      const name = eventId ? `ventas-${eventId.slice(0, 8)}-${day}.csv` : `ventas-${day}.csv`;
      return csvResponse(name, csv);
    }

    if (type === 'tickets') {
      if (!eventId) {
        return NextResponse.json({ error: 'eventId requerido para exportar asistentes' }, { status: 400 });
      }
      const tickets = await prisma.ticket.findMany({
        where: {
          eventId,
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
        },
        orderBy: { createdAt: 'asc' },
        take: 10000,
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
      const csv = toCsv(
        [
          'ticket_id',
          'evento',
          'titular',
          'tipo',
          'estado',
          'entrada',
          'qr',
          'pedido_id',
          'comprador',
          'email',
          'canal',
        ],
        tickets.map((t) => [
          t.id,
          t.event?.name ?? '',
          t.holderName,
          t.ticketType?.name ?? 'General',
          t.status,
          t.entryTime ? t.entryTime.toISOString() : '',
          t.qrCode,
          t.order?.id ?? '',
          `${t.order?.buyerName ?? ''} ${t.order?.buyerLastName ?? ''}`.trim(),
          t.order?.buyerEmail ?? '',
          t.order?.channel ?? '',
        ])
      );
      return csvResponse(`asistentes-${eventId.slice(0, 8)}-${day}.csv`, csv);
    }

    return NextResponse.json({ error: 'type debe ser orders o tickets' }, { status: 400 });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/export');
  }
}
