import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { escapeHtml as esc } from '@/lib/html-escape';
import { getBrand } from '@/lib/brand/brand';
import { brandLogoHtml } from '@/lib/brand/email';
import { shopOrderAccessQuery } from '@/lib/access-token';
import { getFallbackBaseUrl } from '@/lib/url';

/** El email de confirmación de un pedido de tienda: líneas con talla/color y enlace a la página del pedido (TI-04/TI-16). */
export function shopOrderEmailHtml(
  order: {
    id: string;
    buyerName: string;
    totalAmount: number;
    items: { quantity: number; unitPrice: number; size: string | null; color: string | null; product: { name: string } | null }[];
  },
  brand: Awaited<ReturnType<typeof getBrand>>,
  baseUrl: string
): string {
  const itemsHtml = order.items
    .map((i) => {
      const variant = [i.size, i.color].filter(Boolean).join(' · ');
      return (
        `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${esc(i.product?.name)}` +
        (variant ? `<br/><span style="font-size:12px;color:#666;">${esc(variant)}</span>` : '') +
        `</td>` +
        `<td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${i.quantity ?? 0}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${Number(i.unitPrice ?? 0).toFixed(2)}€</td></tr>`
      );
    })
    .join('');
  const orderUrl = `${baseUrl}/tienda/confirmacion/${order.id}?${shopOrderAccessQuery(order.id)}`;
  return (
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
    brandLogoHtml(brand, baseUrl, 32, 'margin:0 0 12px;') +
    `<h2 style="color:${brand.colors.emailAccent};">Pedido confirmado</h2>` +
    `<p>Hola ${esc(order.buyerName)},</p>` +
    `<p>Hemos recibido el pago de tu pedido de merchandising.</p>` +
    `<table style="width:100%;border-collapse:collapse;">` +
    `<tr style="background:#f3f4f6;"><th style="padding:8px;text-align:left;">Producto</th>` +
    `<th style="padding:8px;">Cant.</th><th style="padding:8px;text-align:right;">Precio</th></tr>` +
    itemsHtml +
    `</table>` +
    `<p style="font-size:18px;font-weight:bold;margin-top:16px;">Total: ${Number(order.totalAmount).toFixed(2)}€</p>` +
    `<p style="margin:20px 0;"><a href="${esc(orderUrl)}" style="background:${brand.colors.emailAccent};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Ver mi pedido</a></p>` +
    `<p style="color:#666;">Te avisaremos cuando lo enviemos.</p></div>`
  );
}

/**
 * Construye y envía el email de confirmación de un pedido de tienda. NO lleva el estado de entrega ni decide si toca enviar: eso es de
 * `sendOrderEmail` (lib/order-email.ts), el único punto de envío, que reclama la concesión antes y anota el resultado después.
 */
export async function deliverShopOrderEmail(
  orderId: string,
  baseUrl?: string
): Promise<{ success: boolean; transport?: string; error?: string; errorCode?: string }> {
  const order = await prisma.shopOrder.findUnique({ where: { id: orderId }, include: { items: { include: { product: true } } } });
  if (!order) return { success: false, error: 'Pedido no encontrado' };
  if (order.status === 'PENDING' || order.status === 'CANCELLED' || order.status === 'REFUNDED') return { success: false, error: 'order_inactive' };
  const brand = await getBrand();
  const result = await sendMail({
    to: order.buyerEmail,
    subject: `Pedido confirmado - ${brand.name} #${order.id.slice(0, 8)}`,
    html: shopOrderEmailHtml(order, brand, baseUrl ?? getFallbackBaseUrl()),
  });
  return { success: result.success, transport: result.transport, error: result.error, errorCode: result.errorCode };
}
