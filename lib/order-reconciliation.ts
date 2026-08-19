import { prisma } from '@/lib/prisma';

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
