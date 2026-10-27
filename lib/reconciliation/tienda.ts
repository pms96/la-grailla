import type { ShopOrderStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { sendMail } from '@/lib/mailer';
import { escapeHtml as esc } from '@/lib/html-escape';
import { getBrand } from '@/lib/brand/brand';
import { alertOperator, alertPaidButInactiveOrder, logPaymentEvent, paymentMatchesOrder, type CompleteOutcome, type PaidInfo } from './shared';
import { alertManuallyRefunded, confirmLatePayment, finishLateRefund, lateRefundMarker } from './late-payment';
import { closeSessionBeforeCancel } from './close-session';
import { releasePendingSlot } from '@/lib/rate-limit';
import { refundReturnsStock } from '@/lib/shop-order-status';
import { reserveShopStock } from '@/lib/product-stock';

/* Reconciliación de pedidos de la TIENDA (módulo Tienda): marcar pagado, liberar stock al caducar, anular y reembolsar. */

/** Marca un pedido de tienda como pagado y envía el email de confirmación (una sola vez). */
export async function completeShopOrder(orderId: string, paid?: PaidInfo): Promise<CompleteOutcome> {
  // Si la pasarela dice cuánto cobró y no cuadra con el pedido, no se marca como pagado (ver paymentMatchesOrder).
  if (!(await paymentMatchesOrder('tienda', orderId, paid))) return 'amount_mismatch';
  const { count } = await prisma.shopOrder.updateMany({
    where: { id: orderId, status: 'PENDING' },
    data: { status: 'PAID' },
  });

  const order = await prisma.shopOrder.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true } } },
  });
  if (!order) return 'missing';
  let outcome: CompleteOutcome = 'completed';
  if (count > 0) await releasePendingSlot(orderId); // ya no está sin pagar: libera su hueco del cupo por IP
  if (count === 0) {
    if (order.status === 'CANCELLED') {
      // P0-05: el pago llegó DESPUÉS de liberar/anular el pedido. Se reactiva si queda stock y, si no, se devuelve el dinero.
      const late = await handleLateShopPayment(order);
      if (late !== 'revived') return late;
      outcome = 'revived';
    } else {
      // Ya pagado (o en preparación, enviado…): nada que hacer. Solo un estado en el que no procede (REFUNDED) merece aviso.
      if (order.status === 'REFUNDED') {
        await alertPaidButInactiveOrder('tienda', orderId, order.status);
        return 'inactive';
      }
      return 'already_completed';
    }
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
    const brand = await getBrand();
    const emailResult = await sendMail({
      to: order.buyerEmail,
      subject: `Pedido confirmado - ${brand.name} #${order.id.slice(0, 8)}`,
      html:
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
        `<h2 style="color:${brand.colors.emailAccent};">Pedido confirmado</h2>` +
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
  return outcome;
}

type ReviveShopResult = 'revived' | 'no_stock' | 'not_cancelled';

/**
 * Reactiva un pedido CANCELLED cuyo pago acaba de confirmarse, si TODAVÍA queda stock: la transición CANCELLED → PAID es condicionada
 * (dos entregas simultáneas no lo reaniman dos veces) y la reserva usa `reserveShopStock`, atómica por variante; si falta stock de
 * cualquier línea se deshace todo (a un SAVEPOINT) y la marca de «reembolsar» se escribe en la MISMA transacción.
 *
 * Todo ocurre bajo un cerrojo por pedido (`pg_advisory_xact_lock`): dos entregas del mismo pago tardío se serializan, así la decisión «sin
 * stock → reembolsar» y la reactivación de otra entrega no pueden cruzarse (antes: una reembolsaba mientras otra, con stock recién liberado,
 * reanimaba → pedido PAID, devuelto y entregado). Se toma antes de bloquear ninguna fila de stock y solo lo toma este camino.
 */
export async function reviveShopOrder(orderId: string): Promise<ReviveShopResult> {
  return prisma.$transaction(async (tx): Promise<ReviveShopResult> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'late-shop:' + orderId}))`;
    const current = await tx.shopOrder.findUnique({ where: { id: orderId }, select: { status: true } });
    if (!current || current.status !== 'CANCELLED') return 'not_cancelled';
    if (await tx.processedWebhookEvent.findUnique({ where: { id: lateRefundMarker(orderId) } })) return 'no_stock';

    await tx.$executeRaw`SAVEPOINT late_revive`;
    const { count } = await tx.shopOrder.updateMany({ where: { id: orderId, status: 'CANCELLED' }, data: { status: 'PAID' } });
    if (count === 0) return 'not_cancelled';
    const order = await tx.shopOrder.findUnique({ where: { id: orderId }, include: { items: true } });
    const stockError = order && order.items.length > 0
      ? await reserveShopStock(tx, order.items.map((i) => ({ productId: i.productId, quantity: i.quantity, size: i.size, color: i.color })))
      : 'sin líneas';
    if (stockError) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT late_revive`;
      await tx.processedWebhookEvent.createMany({ data: [{ id: lateRefundMarker(orderId) }], skipDuplicates: true });
      return 'no_stock';
    }
    return 'revived';
  });
}

async function handleLateShopPayment(order: { id: string; buyerName: string; buyerEmail: string; totalAmount: number; paymentProvider: string | null; paymentId: string | null }): Promise<CompleteOutcome> {
  const gateway = await confirmLatePayment('tienda', order);
  const claim = async () => (await prisma.shopOrder.updateMany({ where: { id: order.id, status: 'CANCELLED' }, data: { status: 'REFUNDED' } })).count > 0;
  const readStatus = async () => (await prisma.shopOrder.findUnique({ where: { id: order.id }, select: { status: true } }))?.status;
  if (gateway.state === 'mismatch') return 'amount_mismatch';
  if (gateway.state === 'not_paid') {
    logPaymentEvent('[late-payment]', { kind: 'tienda', orderId: order.id, reason: 'gateway_says_not_paid', status: gateway.status }, 'warn');
    return 'inactive';
  }
  if (gateway.state === 'unverifiable') {
    await alertOperator({
      kind: 'tienda',
      tag: '[late-payment]',
      orderId: order.id,
      reason: 'unverifiable',
      details: { detail: gateway.reason },
      dedupeKey: `late-unverifiable:${order.id}`,
      subject: `⚠️ Pago sobre un pedido anulado que no se puede comprobar (${order.id.slice(0, 8)})`,
      html:
        `<p>Ha llegado la confirmación de un pago para el pedido de tienda <strong>${esc(order.id)}</strong>, que ya estaba anulado, pero no se ha podido comprobar con la pasarela (${esc(gateway.reason)}).</p>` +
        '<p>No se ha reactivado ni reembolsado nada. Revisa el cobro en la pasarela y resuélvelo a mano.</p>',
    });
    return 'late_unresolved';
  }

  if (gateway.state === 'refunded') {
    if (!gateway.ours) {
      await alertManuallyRefunded('tienda', order.id, 'REFUNDED');
      return 'inactive';
    }
    return finishLateRefund({ kind: 'tienda', order, provider: gateway.provider, alreadyRefunded: true, claim, readStatus });
  }

  const revived = await reviveShopOrder(order.id);
  if (revived === 'revived') {
    logPaymentEvent('[late-payment]', { kind: 'tienda', orderId: order.id, reason: 'revived' }, 'warn');
    return 'revived';
  }
  if (revived === 'not_cancelled') {
    const now = await prisma.shopOrder.findUnique({ where: { id: order.id }, select: { status: true } });
    return now?.status === 'PAID' ? 'already_completed' : 'inactive';
  }

  // Sin stock: reembolso total (ver finishLateRefund).
  return finishLateRefund({ kind: 'tienda', order, provider: gateway.provider, claim, readStatus });
}

// Devuelve true si ESTA llamada lo liberó (false: ya no estaba PENDING).
export async function releaseExpiredShopOrder(orderId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.shopOrder.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status: 'CANCELLED', idempotencyKey: null },
    });
    if (count === 0) return false;

    const order = await tx.shopOrder.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return false;

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
    return true;
  }).then(async (released) => {
    if (released) await releasePendingSlot(orderId); // libera su hueco del cupo de pedidos pendientes por IP
    return released;
  });
}

export type InvalidateShopOrderResult =
  | { success: true; status: ShopOrderStatus }
  | { success: false; error: string };

const PAID_SHOP_ORDER_STATUSES: ShopOrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

/**
 * Cancela o reembolsa un pedido de tienda desde el admin — equivalente de
 * invalidateOrder() para ShopOrder, que hasta ahora no tenía ninguna lógica
 * de negocio: el PUT del admin era un simple cambio de `status` que ni
 * devolvía el dinero cobrado ni liberaba el stock reservado en ProductVariant.
 * - Libera el stock reservado de las variantes (reservado ya desde la
 *   creación del pedido, esté PENDING o pagado — ver reserveShopStock).
 * - En REFUNDED con pago real (no mock), intenta reembolso en la pasarela primero.
 * - "Cancelar" un pedido ya pagado con un proveedor real se rechaza (igual que
 *   invalidateOrder): hay que usar "Reembolsar", la única acción que sí
 *   devuelve el dinero.
 * - No actúa si el pedido ya está CANCELLED/REFUNDED.
 */
export async function invalidateShopOrder(
  shopOrderId: string,
  mode: 'CANCELLED' | 'REFUNDED'
): Promise<InvalidateShopOrderResult> {
  const order = await prisma.shopOrder.findUnique({
    where: { id: shopOrderId },
    include: { items: true },
  });
  if (!order) return { success: false, error: 'Pedido no encontrado' };
  if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
    return { success: false, error: 'Este pedido ya está anulado' };
  }

  const isPaid = PAID_SHOP_ORDER_STATUSES.includes(order.status);
  const paidWithRealGateway = Boolean(order.paymentProvider && order.paymentProvider !== 'mock' && order.paymentId);

  if (mode === 'CANCELLED' && isPaid && paidWithRealGateway) {
    return {
      success: false,
      error: 'Este pedido ya está pagado — usa "Reembolsar" en vez de "Cancelar" para devolver el dinero al comprador.',
    };
  }

  if (mode === 'REFUNDED' && !isPaid) {
    return { success: false, error: 'Solo se pueden reembolsar pedidos ya pagados' };
  }

  // Anular un pedido sin pagar: se cierra su sesión de pago (ver invalidateOrder de entradas); si ya estaba pagado, se completa y no se anula.
  if (mode === 'CANCELLED' && order.status === 'PENDING') {
    const { paid } = await closeSessionBeforeCancel('tienda', order);
    if (paid) {
      await completeShopOrder(shopOrderId, paid);
      return { success: false, error: 'El comprador ya había pagado este pedido: se ha marcado como pagado y no se ha anulado. Usa "Reembolsar" si quieres devolverle el dinero.' };
    }
  }

  // Mismo TOCTOU que invalidateOrder: reclama la transición con un
  // updateMany condicionado al status exacto leído (compare-and-swap) antes
  // de tocar la pasarela o liberar stock, para que dos peticiones
  // concurrentes sobre el mismo pedido no acaben reembolsando/liberando
  // stock por duplicado.
  const claim = await prisma.shopOrder.updateMany({
    where: { id: shopOrderId, status: order.status },
    data: { status: mode, idempotencyKey: null },
  });
  if (claim.count === 0) {
    return { success: false, error: 'El pedido cambió de estado mientras se procesaba; vuelve a intentarlo' };
  }
  // Anulado o reembolsado: ya no está sin pagar, así que libera su hueco del cupo de pedidos pendientes por IP.
  await releasePendingSlot(shopOrderId);

  if (mode === 'REFUNDED' && paidWithRealGateway && order.paymentProvider && order.paymentId) {
    try {
      const provider = await getPaymentProviderByName(order.paymentProvider, 'tienda');
      const refund = await provider.refund(order.paymentId, order.totalAmount, `refund_${order.id}`);
      if (!refund.success) {
        await prisma.shopOrder.update({ where: { id: shopOrderId }, data: { status: order.status } });
        return { success: false, error: refund.error ?? 'El reembolso en la pasarela ha fallado' };
      }
    } catch (err) {
      await prisma.shopOrder.update({ where: { id: shopOrderId }, data: { status: order.status } });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Error al reembolsar en la pasarela',
      };
    }
  }

  // Con la mercancía ya enviada o entregada el dinero se devuelve pero el stock NO se repone (no ha vuelto al almacén).
  if (mode === 'CANCELLED' || refundReturnsStock(order.status)) {
    const { releaseShopStock } = await import('@/lib/product-stock');
    await prisma.$transaction((tx) =>
      releaseShopStock(
        tx,
        (order.items ?? []).map((i) => ({ productId: i.productId, quantity: i.quantity, size: i.size, color: i.color }))
      )
    );
  }

  return { success: true, status: mode };
}
