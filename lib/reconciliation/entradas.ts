import { getFallbackBaseUrl } from '@/lib/url';
import type { OrderStatus, TicketStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { sendTicketsEmail } from '@/lib/tickets';
import { alertPaidButInactiveOrder, paymentMatchesOrder, type PaidInfo } from './shared';

/* Reconciliación de pedidos de ENTRADAS (módulo Entradas): marcar pagado, liberar aforo al caducar, anular y reembolsar. Los pedidos de
 * la tienda están en ./tienda.ts: una web con solo Tienda no carga nada de entradas (PDF, wallet, aforo). */

// Compartido entre el webhook de Stripe y la reconciliación periódica de
// SumUp (app/api/cron/reconcile-payments) — ambos necesitan exactamente la
// misma operación "marcar como pagado" y no tiene sentido mantenerla
// duplicada en dos sitios.
// Idempotente y seguro ante concurrencia: la transición PENDING -> COMPLETED
// se hace con un updateMany condicionado al estado actual (atómico a nivel
// de fila en la base de datos), no con un "leer estado, decidir, escribir"
// — así, si el webhook y el cron (o dos reintentos del webhook) llegan casi
// a la vez, solo uno de los dos gana la transición y el resto no reescribe
// nada. Tras completar (o si ya estaba COMPLETED sin email), intenta enviar
// las entradas: el comprador no debe depender de volver a /confirmacion.
export async function completeOrder(orderId: string, baseUrl?: string, paid?: PaidInfo): Promise<void> {
  // Si la pasarela dice cuánto cobró y no cuadra con el pedido, no se completa (ver paymentMatchesOrder).
  if (!(await paymentMatchesOrder('entradas', orderId, paid))) return;
  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status: 'COMPLETED' },
    });
    if (count > 0) {
      await tx.ticket.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'VALID' } });
    }
    const order = await tx.order.findUnique({ where: { id: orderId } });
    return { transitioned: count > 0, order };
  });

  const { transitioned, order } = result;
  if (!order) return;
  if (!transitioned && order.status !== 'COMPLETED') {
    await alertPaidButInactiveOrder('entradas', orderId, order.status);
    return;
  }

  try {
    await sendTicketsEmail(orderId, false, baseUrl ?? getFallbackBaseUrl());
  } catch (error) {
    console.error(
      `[completeOrder] Error enviando entradas del pedido ${orderId}:`,
      error instanceof Error ? error.message : error
    );
  }

  try {
    const { checkCapacityAlerts } = await import('@/lib/capacity-alerts');
    await checkCapacityAlerts(order.eventId);
  } catch (error) {
    console.error(
      `[completeOrder] Error alertas aforo ${order.eventId}:`,
      error instanceof Error ? error.message : error
    );
  }
}

// Si el checkout expira sin pagarse (el comprador nunca completa el pago),
// hay que soltar el stock reservado en la creación del pedido — si no, las
// entradas de ese carrito quedan "vendidas" para siempre y un evento con
// aforo ajustado puede marcarse como agotado sin haber cobrado nada.
// La transición PENDING -> CANCELLED es atómica (updateMany condicionado al
// estado actual): si completeOrder ya ganó la carrera para este pedido, el
// updateMany afecta 0 filas y no tocamos tickets ni soldCount — evita soltar
// stock que ya pertenece a un pedido pagado.
export async function releaseExpiredOrder(orderId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status: 'CANCELLED', idempotencyKey: null },
    });
    if (count === 0) return;

    const order = await tx.order.findUnique({ where: { id: orderId }, include: { tickets: true } });
    if (!order) return;

    const quantityByType = new Map<string, number>();
    for (const ticket of order.tickets) {
      if (!ticket.ticketTypeId) continue;
      quantityByType.set(ticket.ticketTypeId, (quantityByType.get(ticket.ticketTypeId) ?? 0) + 1);
    }

    await tx.ticket.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    for (const [ticketTypeId, quantity] of quantityByType.entries()) {
      await tx.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { decrement: quantity } } });
    }
  });
}

export type InvalidateOrderResult =
  | { success: true; status: OrderStatus }
  | { success: false; error: string };

/**
 * Cancela o reembolsa un pedido de entradas desde el admin.
 * - Libera stock (soldCount) de tickets aún activos.
 * - En REFUNDED con pago con tarjeta, intenta reembolso en la pasarela primero.
 * - No actúa si el pedido ya está CANCELLED/REFUNDED o si alguna entrada está USED.
 */
export async function invalidateOrder(
  orderId: string,
  mode: 'CANCELLED' | 'REFUNDED'
): Promise<InvalidateOrderResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { tickets: true },
  });
  if (!order) return { success: false, error: 'Pedido no encontrado' };
  if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
    return { success: false, error: 'Este pedido ya está anulado' };
  }
  if ((order.tickets ?? []).some((t) => t.status === 'USED')) {
    return { success: false, error: 'Hay entradas ya usadas; no se puede anular' };
  }

  // "Cancelar" (a diferencia de "Reembolsar") nunca ha llamado a la pasarela
  // de pago — libera aforo y anula las entradas, pero el comprador se queda
  // sin su dinero si el pedido ya estaba cobrado. Un pedido COMPLETED pagado
  // de verdad con tarjeta (no mock) solo puede anularse vía REFUNDED, que sí
  // intenta el reembolso antes de tocar nada.
  if (
    mode === 'CANCELLED' &&
    order.status === 'COMPLETED' &&
    order.paymentMethod === 'CARD' &&
    order.paymentProvider &&
    order.paymentProvider !== 'mock'
  ) {
    return {
      success: false,
      error: 'Este pedido ya está pagado con tarjeta — usa "Reembolsar" en vez de "Cancelar" para devolver el dinero al comprador.',
    };
  }

  if (mode === 'REFUNDED' && order.status !== 'COMPLETED') {
    return { success: false, error: 'Solo se pueden reembolsar pedidos completados' };
  }

  // TOCTOU: hasta aquí solo se ha LEÍDO el pedido — dos peticiones
  // concurrentes (doble clic en "Reembolsar", dos admins a la vez) pasarían
  // ambas los checks de arriba antes de que ninguna escriba nada, y las dos
  // acabarían llamando a la pasarela y decrementando soldCount por
  // duplicado. Se reclama la transición de estado con un updateMany
  // condicionado al status exacto que se acaba de leer (compare-and-swap):
  // si otra petición ya cambió el estado entre la lectura y este punto,
  // count será 0 y se aborta sin tocar la pasarela ni el stock.
  const claim = await prisma.order.updateMany({
    where: { id: orderId, status: order.status },
    data: { status: mode, idempotencyKey: null },
  });
  if (claim.count === 0) {
    return { success: false, error: 'El pedido cambió de estado mientras se procesaba; vuelve a intentarlo' };
  }

  if (mode === 'REFUNDED' && order.paymentMethod === 'CARD' && order.paymentProvider && order.paymentId && order.paymentProvider !== 'mock') {
    try {
      const provider = await getPaymentProviderByName(order.paymentProvider);
      const refund = await provider.refund(order.paymentId, order.totalAmount, `refund_${order.id}`);
      if (!refund.success) {
        await prisma.order.update({ where: { id: orderId }, data: { status: order.status } });
        return { success: false, error: refund.error ?? 'El reembolso en la pasarela ha fallado' };
      }
    } catch (err) {
      await prisma.order.update({ where: { id: orderId }, data: { status: order.status } });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Error al reembolsar en la pasarela',
      };
    }
  }

  const activeStatuses: TicketStatus[] = ['PENDING', 'VALID'];
  const quantityByType = new Map<string, number>();
  for (const ticket of order.tickets ?? []) {
    if (!activeStatuses.includes(ticket.status)) continue;
    if (!ticket.ticketTypeId) continue;
    quantityByType.set(ticket.ticketTypeId, (quantityByType.get(ticket.ticketTypeId) ?? 0) + 1);
  }

  const ticketStatus: TicketStatus = mode === 'REFUNDED' ? 'REFUNDED' : 'CANCELLED';

  await prisma.$transaction([
    prisma.ticket.updateMany({
      where: { orderId, status: { in: activeStatuses } },
      data: { status: ticketStatus },
    }),
    ...Array.from(quantityByType.entries()).map(([ticketTypeId, quantity]) =>
      prisma.ticketType.update({
        where: { id: ticketTypeId },
        data: { soldCount: { decrement: quantity } },
      })
    ),
  ]);

  return { success: true, status: mode };
}
