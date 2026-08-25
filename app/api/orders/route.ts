export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { Order, TicketStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { generateQRCode } from '@/lib/qr';
import { getConfig } from '@/lib/config';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { checkCapacityAlerts } from '@/lib/capacity-alerts';
import { getPaymentProvider } from '@/lib/payment-adapter';
import { getBaseUrl } from '@/lib/url';
import { handleApiError } from '@/lib/api-error';
import { orderAccessQuery, signOrderAccess } from '@/lib/access-token';
import { hasEventEnded } from '@/lib/active-event';

// Error de negocio esperado (sin stock, aforo lleno...) lanzado DENTRO de la
// transacción para abortarla — se distingue de un error inesperado al
// capturarlo justo después del $transaction.
class OrderRejectedError extends Error {}

// Dos peticiones casi simultáneas con la misma idempotencyKey (reintento de
// red, doble clic justo antes de que se desactive el botón) intentan crear
// el pedido a la vez; la que pierde la carrera del UNIQUE de Postgres
// termina aquí en vez de duplicar el pedido/cobro.
class DuplicateOrderError extends Error {}

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
  queueToken: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    // Configurable desde el panel (Configuración > Entradas) porque el valor por
    // defecto puede ser demasiado agresivo para tráfico legítimo desde una misma
    // IP compartida (wifi de un local, datos móviles con NAT) el día del evento.
    const [rateLimitPerIpStr, rateLimitWindowStr] = await Promise.all([
      getConfig('orders_rate_limit_per_ip'),
      getConfig('orders_rate_limit_window_seconds'),
    ]);
    const rateLimitPerIp = parseInt(rateLimitPerIpStr, 10) || 10;
    const rateLimitWindowMs = (parseInt(rateLimitWindowStr, 10) || 60) * 1000;
    const limit = await rateLimit('orders', getClientIp(request), rateLimitPerIp, rateLimitWindowMs);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Has realizado demasiados intentos. Espera un momento antes de volver a intentarlo.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const body = createOrderSchema.parse(await request.json());
    const { eventId, buyerName, buyerLastName, buyerEmail, items, queueToken, idempotencyKey } = body;

    // Un reintento (red, doble clic, "atrás" + reenviar) con la misma clave
    // que un pedido que ya existe no debe crear un segundo pedido/cobro —
    // se devuelve el mismo resultado de éxito y el frontend manda al
    // comprador a /confirmacion, que ya sabe reconciliar el estado real del
    // pago. No hace falta comprobar más campos: la clave la genera el propio
    // navegador y solo tiene sentido comparada consigo misma.
    if (idempotencyKey) {
      const existingOrder = await prisma.order.findUnique({ where: { idempotencyKey } });
      if (existingOrder) {
        return NextResponse.json({
          success: true,
          orderId: existingOrder.id,
          totalAmount: existingOrder.totalAmount,
          checkoutUrl: null,
          accessToken: signOrderAccess(existingOrder.id),
        });
      }
    }

    // Validate event
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: { ticketTypes: true },
    });
    if (!event || event.status !== 'PUBLISHED') {
      return NextResponse.json({ error: 'Evento no disponible' }, { status: 400 });
    }
    if (hasEventEnded(event.date)) {
      return NextResponse.json({ error: 'Este evento ya ha finalizado' }, { status: 400 });
    }

    // Con la sala de espera activa, solo se puede comprar con un turno
    // ADMITTED vigente — sin esto, cualquiera podría saltarse la cola
    // llamando directamente a este endpoint.
    let queueEntry: Awaited<ReturnType<typeof prisma.waitingRoomEntry.findUnique>> = null;
    if (event.waitingRoomEnabled) {
      queueEntry = queueToken ? await prisma.waitingRoomEntry.findUnique({ where: { token: queueToken } }) : null;
      if (
        !queueEntry ||
        queueEntry.eventId !== eventId ||
        queueEntry.status !== 'ADMITTED' ||
        !queueEntry.expiresAt ||
        queueEntry.expiresAt < new Date()
      ) {
        return NextResponse.json(
          { error: 'Tu turno ha expirado o no es válido. Vuelve a la sala de espera.' },
          { status: 403 }
        );
      }
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
        // Límite de entradas por email, configurable por evento (evita que un
        // mismo comprador se lleve una parte desproporcionada del aforo). Ya
        // dentro del lock por evento, así que es seguro frente a compras
        // concurrentes del mismo comprador.
        if (event.maxTicketsPerEmail != null) {
          const alreadyBoughtByEmail = await tx.ticket.count({
            where: {
              eventId,
              status: { notIn: ['CANCELLED', 'REFUNDED'] },
              order: { buyerEmail: { equals: buyerEmail, mode: 'insensitive' } },
            },
          });
          if (alreadyBoughtByEmail + totalTickets > event.maxTicketsPerEmail) {
            throw new OrderRejectedError(
              `Este email ya ha comprado el máximo de entradas permitido para este evento (${event.maxTicketsPerEmail})`
            );
          }
        }

        const issuedCount = await tx.ticket.count({
          where: { eventId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        });
        if (issuedCount + totalTickets > event.maxCapacity) {
          throw new OrderRejectedError('Aforo completo');
        }

        let newOrder: Order;
        try {
          newOrder = await tx.order.create({
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
              idempotencyKey: idempotencyKey ?? null,
            },
          });
        } catch (err) {
          // P2002 en idempotencyKey: alguien ganó la carrera con la misma
          // clave entre la comprobación de arriba y este insert. Es el mismo
          // comprador reintentando, no un tipo de entrada distinto — no hay
          // nada que compensar (el stock reservado por ESTA transacción se
          // deshace solo al lanzar, porque el $transaction hace rollback).
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new DuplicateOrderError();
          }
          throw err;
        }

        // createMany en vez de un create por unidad: con el advisory lock de
        // arriba serializando a todos los compradores del mismo evento, cada
        // ida y vuelta a la base de datos dentro de la transacción alarga la
        // cola para el siguiente comprador — agrupar N inserts en 1 reduce
        // notablemente el tiempo que cada transacción mantiene el lock.
        const ticketsToCreate = ticketData.flatMap((td) =>
          Array.from({ length: td.quantity }, () => ({
            orderId: newOrder.id,
            eventId,
            ticketTypeId: td.ticketTypeId,
            qrCode: generateQRCode(),
            holderName: `${buyerName} ${buyerLastName}`,
            status: (isGatewayLive ? 'PENDING' : 'VALID') as TicketStatus,
          }))
        );
        await tx.ticket.createMany({ data: ticketsToCreate });

        // Reserva de stock: se cuenta como vendida desde que se reserva en el
        // checkout, no solo cuando se confirma el pago (igual que el aforo).
        // Segura frente a condiciones de carrera porque ya estamos dentro del
        // lock por evento tomado arriba.
        for (const td of ticketData) {
          await tx.ticketType.update({
            where: { id: td.ticketTypeId },
            data: { soldCount: { increment: td.quantity } },
          });
        }

        return newOrder;
      }, {
        // Con muchos compradores concurrentes para el mismo evento, las
        // transacciones se encolan esperando el advisory lock de arriba — el
        // timeout de 5s por defecto de Prisma mata la transacción antes de
        // que le toque turno, aunque la operación en sí sea rapidísima.
        // Verificado con test de carga real (300 compradores simultáneos):
        // sin este ajuste, Prisma lanza P2028 "Transaction already closed".
        maxWait: 20_000,
        timeout: 20_000,
      })
      .catch((error) => {
        if (error instanceof OrderRejectedError) return error;
        if (error instanceof DuplicateOrderError) return error;
        throw error;
      });

    if (order instanceof OrderRejectedError) {
      return NextResponse.json({ error: order.message }, { status: 400 });
    }

    if (order instanceof DuplicateOrderError) {
      // La otra petición con la misma clave ya ha confirmado (o está a punto
      // de confirmar) el pedido real — se le devuelve al comprador el mismo
      // "éxito" sin checkoutUrl, así el frontend le manda a /confirmacion,
      // que reconcilia el estado real del pago sin arriesgarse a abrir una
      // segunda sesión de cobro.
      const existingOrder = idempotencyKey
        ? await prisma.order.findUnique({ where: { idempotencyKey } })
        : null;
      if (!existingOrder) {
        return NextResponse.json({ error: 'No se ha podido procesar el pedido. Inténtalo de nuevo.' }, { status: 409 });
      }
      return NextResponse.json({
        success: true,
        orderId: existingOrder.id,
        totalAmount: existingOrder.totalAmount,
        checkoutUrl: null,
        accessToken: signOrderAccess(existingOrder.id),
      });
    }

    // Libera el hueco de la sala de espera ya, en vez de esperar a que
    // expire por tiempo, para que el siguiente en la cola entre antes. Solo
    // se marca al confirmar el éxito real (no si luego falla la pasarela),
    // para que el comprador conserve su turno si necesita reintentar.
    const releaseQueueSlot = () =>
      queueEntry
        ? prisma.waitingRoomEntry.update({ where: { id: queueEntry.id }, data: { status: 'COMPLETED' } }).catch(() => {})
        : Promise.resolve();

    if (!isGatewayLive) {
      void checkCapacityAlerts(eventId);
      await releaseQueueSlot();
      return NextResponse.json({
        success: true,
        orderId: order.id,
        totalAmount,
        checkoutUrl: null,
        accessToken: signOrderAccess(order.id),
      });
    }

    const baseUrl = getBaseUrl(request);
    try {
      const session = await paymentProvider.createCheckoutSession({
        amount: totalAmount,
        currency: 'EUR',
        description: `Entradas ${event.name}`,
        orderId: order.id,
        successUrl: baseUrl + '/confirmacion/' + order.id + '?' + orderAccessQuery(order.id),
        cancelUrl: baseUrl + '/eventos/' + event.slug + '/comprar',
        customerEmail: buyerEmail,
        metadata: { orderType: 'ticket' },
      });
      await prisma.order.update({ where: { id: order.id }, data: { paymentId: session.sessionId } });
      await releaseQueueSlot();
      return NextResponse.json({
        success: true,
        orderId: order.id,
        totalAmount,
        checkoutUrl: session.checkoutUrl,
        accessToken: signOrderAccess(order.id),
      });
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
        // Se limpia idempotencyKey a null (Postgres permite varios NULL en una
        // columna @unique): si no, un reintento legítimo del comprador con la
        // misma clave chocaría contra este pedido ya muerto y el comprobante
        // de idempotencia de arriba le devolvería "éxito" sobre un pedido
        // cancelado en vez de dejarle intentarlo de nuevo de verdad.
        prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', idempotencyKey: null } }),
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
