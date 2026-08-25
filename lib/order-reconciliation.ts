import type { OrderStatus, TicketStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { sendTicketsEmail } from '@/lib/tickets';
import { sendMail } from '@/lib/mailer';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Compartido entre el webhook de Stripe y la reconciliación periódica de
// SumUp (app/api/cron/reconcile-payments) — ambos necesitan exactamente la
// misma operación "marcar como pagado" y no tiene sentido mantenerla
// duplicada en dos sitios.
// Idempotente: puede llamarse más de una vez para el mismo pedido (un
// webhook reenviado, o el cron y el webhook confirmando casi a la vez) sin
// efecto duplicado, porque solo actúa si el pedido sigue en PENDING.
// Tras completar (o si ya estaba COMPLETED sin email), intenta enviar las
// entradas: el comprador no debe depender de volver a /confirmacion.
export async function completeOrder(orderId: string, baseUrl?: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return;

  if (order.status === 'PENDING') {
    await prisma.$transaction([
      prisma.order.update({ where: { id: orderId }, data: { status: 'COMPLETED' } }),
      prisma.ticket.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'VALID' } }),
    ]);
  } else if (order.status !== 'COMPLETED') {
    return;
  }

  try {
    await sendTicketsEmail(orderId, false, baseUrl ?? process.env.NEXTAUTH_URL);
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
    prisma.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED', idempotencyKey: null },
    }),
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

/** Marca un pedido de tienda como pagado y envía el email de confirmación (una sola vez). */
export async function completeShopOrder(orderId: string): Promise<void> {
  const order = await prisma.shopOrder.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true } } },
  });
  if (!order) return;
  if (order.status !== 'PENDING') return;

  await prisma.shopOrder.update({
    where: { id: orderId },
    data: { status: 'PAID' },
  });

  const itemsHtml = (order.items ?? [])
    .map(
      (i) =>
        `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${esc(i?.product?.name)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #eee;">${i?.quantity ?? 0}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #eee;">${(i?.unitPrice ?? 0).toFixed(2)}€</td></tr>`
    )
    .join('');

  try {
    const emailResult = await sendMail({
      to: order.buyerEmail,
      subject: `Pedido confirmado - La Grailla #${order.id.slice(0, 8)}`,
      html:
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
        `<h2 style="color:#a855f7;">Pedido confirmado</h2>` +
        `<p>Hola ${esc(order.buyerName)},</p>` +
        `<p>Hemos recibido el pago de tu pedido de merchandising.</p>` +
        `<table style="width:100%;border-collapse:collapse;">` +
        `<tr style="background:#f3f4f6;"><th style="padding:8px;text-align:left;">Producto</th>` +
        `<th style="padding:8px;">Cant.</th><th style="padding:8px;">Precio</th></tr>` +
        itemsHtml +
        `</table>` +
        `<p style="font-size:18px;font-weight:bold;margin-top:16px;">Total: ${Number(order.totalAmount).toFixed(2)}€</p>` +
        `<p style="color:#666;">Te avisaremos cuando lo enviemos.</p></div>`,
    });
    if (!emailResult.success) {
      console.error(`[completeShopOrder] Email fallido para ${orderId}:`, emailResult.error);
    }
  } catch (error) {
    console.error(
      `[completeShopOrder] Error enviando email ${orderId}:`,
      error instanceof Error ? error.message : error
    );
  }
}

export async function releaseExpiredShopOrder(orderId: string): Promise<void> {
  const order = await prisma.shopOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order || order.status !== 'PENDING') return;

  await prisma.$transaction(async (tx) => {
    const { releaseShopStock } = await import('@/lib/product-stock');
    await releaseShopStock(
      tx,
      (order.items ?? []).map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        size: i.size,
        color: i.color,
      }))
    );
    await tx.shopOrder.update({
      where: { id: orderId },
      data: { status: 'CANCELLED', idempotencyKey: null },
    });
  });
}

/** Resuelve si el orderId del metadata de Stripe es pedido de entradas o de tienda. */
export async function resolvePaidCheckout(orderId: string, baseUrl?: string): Promise<'ticket' | 'shop' | null> {
  const ticketOrder = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (ticketOrder) {
    await completeOrder(orderId, baseUrl);
    return 'ticket';
  }
  const shopOrder = await prisma.shopOrder.findUnique({ where: { id: orderId }, select: { id: true } });
  if (shopOrder) {
    await completeShopOrder(orderId);
    return 'shop';
  }
  return null;
}

export async function resolveExpiredCheckout(orderId: string): Promise<'ticket' | 'shop' | null> {
  const ticketOrder = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (ticketOrder) {
    await releaseExpiredOrder(orderId);
    return 'ticket';
  }
  const shopOrder = await prisma.shopOrder.findUnique({ where: { id: orderId }, select: { id: true } });
  if (shopOrder) {
    await releaseExpiredShopOrder(orderId);
    return 'shop';
  }
  return null;
}
