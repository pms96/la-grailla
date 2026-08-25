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

/** Avisa al equipo cuando un pago se confirma sobre un pedido que ya fue cancelado/liberado — requiere intervención manual (el stock ya pudo venderse a otra persona). */
async function alertPaidButInactiveOrder(kind: 'entradas' | 'tienda', orderId: string, status: string): Promise<void> {
  console.error(`[order-reconciliation] Pago confirmado para pedido de ${kind} ${orderId} pero su estado ya era ${status} — requiere revisión manual.`);
  try {
    await sendMail({
      to: 'grupolagrailla@gmail.com',
      subject: `⚠️ Pago confirmado sobre pedido ya anulado (${orderId.slice(0, 8)})`,
      html:
        `<p>Se ha confirmado un pago de ${kind} para el pedido <strong>${esc(orderId)}</strong>, ` +
        `pero su estado ya era <strong>${esc(status)}</strong> (probablemente liberado por caducidad antes de que llegara la confirmación de pago).</p>` +
        `<p>El stock de este pedido puede haberse vendido ya a otra persona. Revisar manualmente y contactar con el comprador si es necesario.</p>`,
    });
  } catch (error) {
    console.error('[alertPaidButInactiveOrder] Error enviando alerta:', error instanceof Error ? error.message : error);
  }
}

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
export async function completeOrder(orderId: string, baseUrl?: string): Promise<void> {
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
  const { count } = await prisma.shopOrder.updateMany({
    where: { id: orderId, status: 'PENDING' },
    data: { status: 'PAID' },
  });

  const order = await prisma.shopOrder.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true } } },
  });
  if (!order) return;
  if (count === 0) {
    if (order.status !== 'PAID') {
      await alertPaidButInactiveOrder('tienda', orderId, order.status);
    }
    return;
  }

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
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.shopOrder.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status: 'CANCELLED', idempotencyKey: null },
    });
    if (count === 0) return;

    const order = await tx.shopOrder.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return;

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
