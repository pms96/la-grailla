export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { adminLacksModule } from '@/lib/modules/access';
import { authOptions } from '@/lib/auth';
import { generateQRCode } from '@/lib/qr';
import { checkCapacityAlerts } from '@/lib/capacity-alerts';
import { handleApiError } from '@/lib/api-error';

class TaquillaSaleRejectedError extends Error {}

const taquillaSaleSchema = z.object({
  eventId: z.string().min(1),
  buyerName: z.string().max(100).optional(),
  buyerLastName: z.string().max(100).optional().nullable(),
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
  idempotencyKey: z.string().optional(),
});

const DIRECT_ENTRY_NAME = 'Venta en taquilla';
// Tope por línea de la venta: un grupo grande cabe de sobra, y un valor absurdo ya no llega a las comprobaciones de aforo.
const MAX_ITEM_QUANTITY = 500;
const EVENT_NOT_OPEN_MESSAGE: Record<string, string> = {
  CANCELLED: 'El evento está cancelado: no se pueden vender entradas.',
  FINISHED: 'El evento ya ha terminado: no se pueden vender entradas.',
  DRAFT: 'El evento todavía no está publicado: publícalo para poder vender entradas.',
};

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const role = session?.user?.role ?? '';
    if (!session?.user || !['ADMIN', 'TAQUILLA'].includes(role)) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
    if (adminLacksModule(session.user, 'entradas')) {
      return NextResponse.json({ error: 'Sin permiso para este módulo' }, { status: 403 });
    }

    const { eventId, buyerName, buyerLastName, buyerEmail, items, paymentMethod, duringEvent, idempotencyKey } =
      taquillaSaleSchema.parse(await request.json());

    // Mismo criterio que app/api/orders/route.ts: un reintento (timeout de
    // red, doble tap en el datáfono) con la misma clave que una venta que ya
    // se registró no debe cobrar ni emitir entradas dos veces.
    if (idempotencyKey) {
      const existing = await prisma.order.findUnique({
        where: { idempotencyKey },
        include: { _count: { select: { tickets: true } }, tickets: { take: 1, select: { status: true } } },
      });
      if (existing) {
        return NextResponse.json({
          success: true,
          orderId: existing.id,
          totalAmount: existing.totalAmount,
          tickets: existing._count.tickets,
          duringEvent: existing.tickets[0]?.status === 'USED',
        });
      }
    }

    if (!duringEvent && !buyerName?.trim()) {
      return NextResponse.json({ error: 'Introduce el nombre del comprador' }, { status: 400 });
    }
    const finalBuyerName = duringEvent ? DIRECT_ENTRY_NAME : (buyerName ?? '').trim();
    const finalBuyerLastName = duringEvent ? '' : (buyerLastName ?? '');
    const holderName = duringEvent ? DIRECT_ENTRY_NAME : finalBuyerName + ' ' + finalBuyerLastName;

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
    // H-080: solo se vende en un evento publicado. Antes se emitían QR (y se cobraba) sobre eventos cancelados, terminados o sin publicar.
    if (event.status !== 'PUBLISHED') {
      return NextResponse.json({ error: EVENT_NOT_OPEN_MESSAGE[event.status] ?? 'Este evento no está a la venta.', code: 'event_not_open' }, { status: 409 });
    }

    const requestedQuantities = new Map<string, number>();
    for (const item of items) {
      // H-080: `Math.max(1, parseInt('abc'))` daba NaN, que pasaba las comprobaciones de aforo y acababa en 500. Cantidad = entero de 1 a MAX_ITEM_QUANTITY.
      const quantity = Number(item?.quantity ?? 1);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
        return NextResponse.json({ error: `Cantidad no válida: indica un número entero de 1 a ${MAX_ITEM_QUANTITY}.` }, { status: 400 });
      }
      requestedQuantities.set(item.ticketTypeId, (requestedQuantities.get(item.ticketTypeId) ?? 0) + quantity);
    }

    const method = paymentMethod === 'card' ? 'CARD' : paymentMethod === 'free' ? 'FREE' : 'CASH';

    const order = await prisma.$transaction(async (tx) => {
      // Mismo criterio que app/api/orders/route.ts: serializa por evento
      // para que dos ventas de taquilla (o una venta y una compra online)
      // simultáneas no puedan leer stock/aforo obsoleto y sobrevender.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;

      // Solo tipos de ESTE evento: antes se aceptaba el de otro evento, se vendía contra el aforo equivocado y subía el contador ajeno.
      const freshTicketTypes = await tx.ticketType.findMany({
        where: { id: { in: Array.from(requestedQuantities.keys()) }, eventId, isActive: true },
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
          idempotencyKey: idempotencyKey ?? null,
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
