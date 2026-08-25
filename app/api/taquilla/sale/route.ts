export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { generateQRCode } from '@/lib/qr';
import { checkCapacityAlerts } from '@/lib/capacity-alerts';
import { handleApiError } from '@/lib/api-error';

class TaquillaSaleRejectedError extends Error {}

const taquillaSaleSchema = z.object({
  eventId: z.string().min(1),
  buyerName: z.string().optional(),
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
  // Evento ya en marcha: el comprador entra directamente, sin pasar por el
  // escáner de puerta — no tiene sentido pedirle nombre ni mandarle un email
  // con una entrada que ya se ha marcado como usada.
  duringEvent: z.boolean().optional(),
});

const DIRECT_ENTRY_NAME = 'Venta en taquilla';

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const role = session?.user?.role ?? '';
    if (!session?.user || !['ADMIN', 'TAQUILLA'].includes(role)) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const { eventId, buyerName, buyerLastName, buyerEmail, items, paymentMethod, duringEvent } = taquillaSaleSchema.parse(
      await request.json()
    );

    if (!duringEvent && !buyerName?.trim()) {
      return NextResponse.json({ error: 'Introduce el nombre del comprador' }, { status: 400 });
    }
    const finalBuyerName = duringEvent ? DIRECT_ENTRY_NAME : (buyerName ?? '').trim();
    const finalBuyerLastName = duringEvent ? '' : (buyerLastName ?? '');
    const holderName = duringEvent ? DIRECT_ENTRY_NAME : finalBuyerName + ' ' + finalBuyerLastName;

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });

    const requestedQuantities = new Map<string, number>();
    for (const item of items) {
      const quantity = Math.max(1, parseInt(String(item?.quantity ?? 1), 10));
      requestedQuantities.set(item.ticketTypeId, (requestedQuantities.get(item.ticketTypeId) ?? 0) + quantity);
    }

    const method = paymentMethod === 'card' ? 'CARD' : paymentMethod === 'free' ? 'FREE' : 'CASH';

    const order = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Mismo criterio que app/api/orders/route.ts: serializa por evento
      // para que dos ventas de taquilla (o una venta y una compra online)
      // simultáneas no puedan leer stock/aforo obsoleto y sobrevender.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;

      const freshTicketTypes = await tx.ticketType.findMany({
        where: { id: { in: Array.from(requestedQuantities.keys()) } },
      });

      let totalAmount = 0;
      const ticketData: { ticketTypeId: string; quantity: number }[] = [];
      for (const [ticketTypeId, quantity] of requestedQuantities) {
        const tt = freshTicketTypes.find((t) => t.id === ticketTypeId);
        if (!tt) throw new TaquillaSaleRejectedError('Tipo de entrada no valido');
        if ((tt.soldCount ?? 0) + quantity > (tt.maxQuantity ?? 0)) {
          throw new TaquillaSaleRejectedError('No quedan entradas de ' + tt.name);
        }
        totalAmount += (tt.price ?? 0) * quantity;
        ticketData.push({ ticketTypeId: tt.id, quantity });
      }
      if (method === 'FREE') totalAmount = 0;

      const totalTickets = ticketData.reduce((sum, t) => sum + t.quantity, 0);
      const issuedCount = await tx.ticket.count({
        where: { eventId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      });
      if (issuedCount + totalTickets > (event.maxCapacity ?? 0)) {
        throw new TaquillaSaleRejectedError('Aforo completo');
      }

      const newOrder = await tx.order.create({
        data: {
          eventId,
          buyerName: finalBuyerName,
          buyerLastName: finalBuyerLastName,
          buyerEmail: duringEvent ? 'taquilla@lagrailla.local' : buyerEmail || 'taquilla@lagrailla.local',
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
          const ticket = await tx.ticket.create({
            data: {
              orderId: newOrder.id,
              eventId,
              ticketTypeId: td.ticketTypeId,
              qrCode: generateQRCode(),
              holderName,
              status: duringEvent ? 'USED' : 'VALID',
              entryTime: duringEvent ? new Date() : null,
            },
          });
          if (duringEvent) {
            await tx.scanLog.create({
              data: { ticketId: ticket.id, eventId, scannerId: session.user?.id ?? null, result: 'VALID' },
            });
          }
        }
        await tx.ticketType.update({
          where: { id: td.ticketTypeId },
          data: { soldCount: { increment: td.quantity } },
        });
      }

      if (duringEvent) {
        await tx.event.update({ where: { id: eventId }, data: { currentCount: { increment: totalTickets } } });
      }

      return { order: newOrder, totalAmount, totalTickets };
    }).catch((error) => {
      if (error instanceof TaquillaSaleRejectedError) return error;
      throw error;
    });

    if (order instanceof TaquillaSaleRejectedError) {
      return NextResponse.json({ error: order.message }, { status: 400 });
    }

    void checkCapacityAlerts(eventId);

    return NextResponse.json({
      success: true,
      orderId: order.order.id,
      totalAmount: order.totalAmount,
      tickets: order.totalTickets,
      duringEvent: Boolean(duringEvent),
    });
  } catch (error) {
    return handleApiError(error, 'POST /api/taquilla/sale');
  }
}
