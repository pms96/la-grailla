import type { ShopOrderStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { sendMail } from '@/lib/mailer';
import { escapeHtml as esc } from '@/lib/html-escape';
import { getBrand } from '@/lib/brand/brand';
import { alertPaidButInactiveOrder, paymentMatchesOrder, type PaidInfo } from './shared';
import { refundReturnsStock } from '@/lib/shop-order-status';

/* Reconciliación de pedidos de la TIENDA (módulo Tienda): marcar pagado, liberar stock al caducar, anular y reembolsar. */

/** Marca un pedido de tienda como pagado y envía el email de confirmación (una sola vez). */
export async function completeShopOrder(orderId: string, paid?: PaidInfo): Promise<void> {
  // Si la pasarela dice cuánto cobró y no cuadra con el pedido, no se marca como pagado (ver paymentMatchesOrder).
  if (!(await paymentMatchesOrder('tienda', orderId, paid))) return;
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
