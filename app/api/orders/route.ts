export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { generateQRCode } from '@/lib/qr';
import { getConfig } from '@/lib/config';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { checkCapacityAlerts } from '@/lib/capacity-alerts';
import { getPaymentProvider } from '@/lib/payment-adapter';
import { getBaseUrl } from '@/lib/url';
import { handleApiError } from '@/lib/api-error';

// Error de negocio esperado (sin stock, aforo lleno...) lanzado DENTRO de la
// transacción para abortarla — se distingue de un error inesperado al
// capturarlo justo después del $transaction.
class OrderRejectedError extends Error {}

const createOrderSchema = z.object({
  eventId: z.string().min(1),
  buyerName: z.string().min(1),
  buyerLastName: z.string().min(1),
  buyerEmail: z.string().email(),
  items: z
    .array(
      z.object({
        ticketTypeId: z.string().min(1),
        quantity: z.number().int().positive(),
      })
    )
    .min(1),
});

export async function POST(request: Request) {
  try {
    const limit = rateLimit('orders', getClientIp(request), 10, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Has realizado demasiados intentos. Espera un momento antes de volver a intentarlo.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const body = createOrderSchema.parse(await request.json());
    const { eventId, buyerName, buyerLastName, buyerEmail, items } = body;

    // Validate event
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: { ticketTypes: true },
    });
    if (!event || event.status !== 'PUBLISHED') {
      return NextResponse.json({ error: 'Evento no disponible' }, { status: 400 });
    }

    // Solo validamos aquí que los ticketTypeId pedidos existen y pertenecen al
    // evento — el stock y el aforo se comprueban MÁS ABAJO, ya dentro del lock
    // de la transacción, con datos frescos. Comprobarlos aquí con el snapshot
    // que acabamos de leer sería una condición de carrera: bajo tráfico
    // concurrente (p. ej. la apertura de venta de un evento con aforo
    // limitado), dos peticiones pueden leer "queda hueco" antes de que
    // ninguna haya escrito, y las dos pasan — sobreventa real, con cobro real
    // de por medio.
    const requestedQuantities = new Map<string, number>();
    for (const item of items) {
      const tt = event.ticketTypes?.find((t) => t?.id === item?.ticketTypeId);
      if (!tt) return NextResponse.json({ error: 'Tipo de entrada no válido' }, { status: 400 });
      requestedQuantities.set(tt.id, (requestedQuantities.get(tt.id) ?? 0) + (item?.quantity ?? 1));
    }
    const totalTickets = Array.from(requestedQuantities.values()).reduce((sum, q) => sum + q, 0);

    const commissionStr = await getConfig('commission_percentage');
    const commissionPct = parseFloat(commissionStr) || 0;

    // Averiguamos la pasarela ANTES de crear nada: si está mal configurada,
    // mejor fallar aquí que dejar tickets huérfanos en estado PENDING.
    const paymentProvider = await getPaymentProvider();
    const isGatewayLive = paymentProvider.name !== 'mock';

    let totalAmount = 0;
    let commissionAmount = 0;

    // Create order + tickets (PENDING hasta que se confirme el pago; VALID solo
    // si no hay pasarela real configurada, para no romper el flujo en local/dev).
    const order = await prisma
      .$transaction(async (tx: Prisma.TransactionClient) => {
        // Serializa la reserva de stock/aforo POR EVENTO: mientras esta
        // transacción no termine (commit o rollback), cualquier otra petición
        // para el MISMO evento se queda esperando aquí antes de leer stock —
        // eventos distintos no se bloquean entre sí. El lock se libera solo al
        // terminar la transacción, no hace falta desbloquearlo a mano.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;

        // Releer con el lock ya tomado: nadie más puede estar a mitad de
        // reservar para este evento en este momento.
        const freshTicketTypes = await tx.ticketType.findMany({
          where: { id: { in: Array.from(requestedQuantities.keys()) } },
        });

        const ticketData: { ticketTypeId: string; quantity: number; name: string }[] = [];
        for (const [ticketTypeId, quantity] of requestedQuantities) {
          const tt = freshTicketTypes.find((t) => t.id === ticketTypeId);
          if (!tt) throw new OrderRejectedError('Tipo de entrada no válido');
          if (tt.soldCount + quantity > tt.maxQuantity) {
            throw new OrderRejectedError(`No hay suficientes entradas de ${tt.name}`);
          }
          totalAmount += tt.price * quantity;
          ticketData.push({ ticketTypeId: tt.id, quantity, name: tt.name });
        }
        commissionAmount = totalAmount * (commissionPct / 100);
        totalAmount += commissionAmount;

        // Aforo: comparar contra entradas emitidas (vendidas), no contra el
        // aforo físico (currentCount), que solo refleja a quienes ya han
        // entrado por puerta.
        const issuedCount = await tx.ticket.count({
          where: { eventId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        });
        if (issuedCount + totalTickets > event.maxCapacity) {
          throw new OrderRejectedError('Aforo completo');
        }

        const newOrder = await tx.order.create({
          data: {
            eventId,
            buyerName,
            buyerLastName,
            buyerEmail,
            totalAmount,
            commission: commissionAmount,
            paymentMethod: 'CARD',
            paymentProvider: paymentProvider.name,
            status: isGatewayLive ? 'PENDING' : 'COMPLETED',
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
                holderName: `${buyerName} ${buyerLastName}`,
                status: isGatewayLive ? 'PENDING' : 'VALID',
              },
            });
          }
          // Reserva de stock: se cuenta como vendida desde que se reserva en el
          // checkout, no solo cuando se confirma el pago (igual que el aforo).
          // Segura frente a condiciones de carrera porque ya estamos dentro del
          // lock por evento tomado arriba.
          await tx.ticketType.update({
            where: { id: td.ticketTypeId },
            data: { soldCount: { increment: td.quantity } },
          });
        }

        return newOrder;
      })
      .catch((error) => {
        if (error instanceof OrderRejectedError) return error;
        throw error;
      });

    if (order instanceof OrderRejectedError) {
      return NextResponse.json({ error: order.message }, { status: 400 });
    }

    if (!isGatewayLive) {
      void checkCapacityAlerts(eventId);
      return NextResponse.json({ success: true, orderId: order.id, totalAmount, checkoutUrl: null });
    }

    const baseUrl = getBaseUrl(request);
    try {
      const session = await paymentProvider.createCheckoutSession({
        amount: totalAmount,
        currency: 'EUR',
        description: `Entradas ${event.name}`,
        orderId: order.id,
        successUrl: baseUrl + '/confirmacion/' + order.id,
        cancelUrl: baseUrl + '/eventos/' + event.slug + '/comprar',
        customerEmail: buyerEmail,
      });
      await prisma.order.update({ where: { id: order.id }, data: { paymentId: session.sessionId } });
      return NextResponse.json({ success: true, orderId: order.id, totalAmount, checkoutUrl: session.checkoutUrl });
    } catch (error) {
      // La pasarela no pudo crear la sesión de cobro: no dejar entradas PENDING
      // colgadas ni que el comprador acabe en "confirmación" sin haber pagado.
      // Y hay que soltar el stock reservado — si no, esas unidades quedan
      // "vendidas" para siempre aunque nunca se haya iniciado el cobro.
      console.error('Ticket checkout session error:', error instanceof Error ? error.message : error);
      const failedTickets = await prisma.ticket.findMany({ where: { orderId: order.id } });
      const quantityByType = new Map<string, number>();
      for (const ticket of failedTickets) {
        if (!ticket.ticketTypeId) continue;
        quantityByType.set(ticket.ticketTypeId, (quantityByType.get(ticket.ticketTypeId) ?? 0) + 1);
      }
      await prisma.$transaction([
        prisma.ticket.updateMany({ where: { orderId: order.id }, data: { status: 'CANCELLED' } }),
        prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } }),
        ...Array.from(quantityByType.entries()).map(([ticketTypeId, quantity]) =>
          prisma.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { decrement: quantity } } })
        ),
      ]);
      return NextResponse.json(
        { error: 'No se ha podido iniciar el pago. Inténtalo de nuevo en unos minutos.' },
        { status: 502 }
      );
    }
  } catch (error) {
    return handleApiError(error, 'POST /api/orders');
  }
}
