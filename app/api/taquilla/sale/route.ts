export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { generateQRCode } from '@/lib/qr';
import { checkCapacityAlerts, getIssuedTicketCount } from '@/lib/capacity-alerts';
import { handleApiError } from '@/lib/api-error';

const taquillaSaleSchema = z.object({
  eventId: z.string().min(1),
  buyerName: z.string().min(1),
  buyerLastName: z.string().optional().nullable(),
  buyerEmail: z.string().email().optional().nullable().or(z.literal('')),
  items: z
    .array(
      z.object({
        ticketTypeId: z.string().min(1),
        quantity: z.union([z.number(), z.string()]).optional(),
      })
    )
    .min(1),
  paymentMethod: z.enum(['card', 'cash', 'free']).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const role = session?.user?.role ?? '';
    if (!session?.user || !['ADMIN', 'TAQUILLA'].includes(role)) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const { eventId, buyerName, buyerLastName, buyerEmail, items, paymentMethod } = taquillaSaleSchema.parse(
      await request.json()
    );

    const event = await prisma.event.findUnique({ where: { id: eventId }, include: { ticketTypes: true } });
    if (!event) return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });

    let totalAmount = 0;
    const ticketData: { ticketTypeId: string; quantity: number }[] = [];

    for (const item of items) {
      const tt = event.ticketTypes?.find((t) => t?.id === item?.ticketTypeId);
      if (!tt) return NextResponse.json({ error: 'Tipo de entrada no valido' }, { status: 400 });
      const quantity = Math.max(1, parseInt(String(item?.quantity ?? 1), 10));
      if ((tt.soldCount ?? 0) + quantity > (tt.maxQuantity ?? 0)) {
        return NextResponse.json({ error: 'No quedan entradas de ' + tt.name }, { status: 400 });
      }
      totalAmount += (tt.price ?? 0) * quantity;
      ticketData.push({ ticketTypeId: tt.id, quantity });
    }

    const totalTickets = ticketData.reduce((sum, t) => sum + t.quantity, 0);
    const issuedCount = await getIssuedTicketCount(eventId);
    if (issuedCount + totalTickets > (event.maxCapacity ?? 0)) {
      return NextResponse.json({ error: 'Aforo completo' }, { status: 400 });
    }

    const method = paymentMethod === 'card' ? 'CARD' : paymentMethod === 'free' ? 'FREE' : 'CASH';
    if (method === 'FREE') totalAmount = 0;

    const order = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const newOrder = await tx.order.create({
        data: {
          eventId,
          buyerName,
          buyerLastName: buyerLastName ?? '',
          buyerEmail: buyerEmail || 'taquilla@lagrailla.local',
          totalAmount,
          commission: 0,
          paymentMethod: method,
          status: 'COMPLETED',
          channel: 'TAQUILLA',
          soldById: session.user?.id ?? null,
        },
      });

      for (const td of ticketData) {
        for (let i = 0; i < td.quantity; i++) {
          await tx.ticket.create({
            data: {
              orderId: newOrder.id,
              eventId,
              ticketTypeId: td.ticketTypeId,
              qrCode: generateQRCode(),
              holderName: buyerName + ' ' + (buyerLastName ?? ''),
              status: 'VALID',
            },
          });
        }
        await tx.ticketType.update({
          where: { id: td.ticketTypeId },
          data: { soldCount: { increment: td.quantity } },
        });
      }

      return newOrder;
    });

    void checkCapacityAlerts(eventId);

    return NextResponse.json({ success: true, orderId: order.id, totalAmount, tickets: totalTickets });
  } catch (error) {
    return handleApiError(error, 'POST /api/taquilla/sale');
  }
}
