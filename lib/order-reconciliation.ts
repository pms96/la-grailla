import type { OrderStatus, TicketStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';

// Compartido entre el webhook de Stripe y la reconciliación periódica de
// SumUp (app/api/cron/reconcile-payments) — ambos necesitan exactamente la
// misma operación "marcar como pagado" y no tiene sentido mantenerla
// duplicada en dos sitios.
// Idempotente: puede llamarse más de una vez para el mismo pedido (un
// webhook reenviado, o el cron y el webhook confirmando casi a la vez) sin
// efecto duplicado, porque solo actúa si el pedido sigue en PENDING.
export async function completeOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== 'PENDING') return;

  await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data: { status: 'COMPLETED' } }),
    prisma.ticket.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'VALID' } }),
  ]);
}

// Si el checkout expira sin pagarse (el comprador nunca completa el pago),
// hay que soltar el stock reservado en la creación del pedido — si no, las
// entradas de ese carrito quedan "vendidas" para siempre y un evento con
// aforo ajustado puede marcarse como agotado sin haber cobrado nada.
export async function releaseExpiredOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { tickets: true },
  });
  if (!order || order.status !== 'PENDING') return;

  const quantityByType = new Map<string, number>();
  for (const ticket of order.tickets) {
    if (!ticket.ticketTypeId) continue;
    quantityByType.set(ticket.ticketTypeId, (quantityByType.get(ticket.ticketTypeId) ?? 0) + 1);
  }

  await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } }),
    prisma.ticket.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'CANCELLED' } }),
    ...Array.from(quantityByType.entries()).map(([ticketTypeId, quantity]) =>
      prisma.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { decrement: quantity } } })
    ),
  ]);
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

  if (mode === 'REFUNDED') {
    if (order.status !== 'COMPLETED') {
      return { success: false, error: 'Solo se pueden reembolsar pedidos completados' };
    }
    if (order.paymentMethod === 'CARD' && order.paymentProvider && order.paymentId && order.paymentProvider !== 'mock') {
      try {
        const provider = await getPaymentProviderByName(order.paymentProvider);
        const refund = await provider.refund(order.paymentId, order.totalAmount);
        if (!refund.success) {
          return { success: false, error: refund.error ?? 'El reembolso en la pasarela ha fallado' };
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Error al reembolsar en la pasarela',
        };
      }
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
    prisma.order.update({
      where: { id: orderId },
      data: { status: mode, idempotencyKey: null },
    }),
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
