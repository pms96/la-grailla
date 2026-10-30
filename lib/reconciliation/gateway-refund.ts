import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { escapeHtml as esc } from '@/lib/html-escape';
import { getBrand } from '@/lib/brand/brand';
import { brandLogoHtml } from '@/lib/brand/email';
import { getFallbackBaseUrl } from '@/lib/url';
import { refundReturnsStock } from '@/lib/shop-order-status';
import { alertOperator, logPaymentEvent } from './shared';

/* Dinero devuelto FUERA de la app (auditoría P1-01 / EN-08, CO-02, TI-08/09). Hasta ahora solo existía el reembolso desde el admin: uno hecho en el panel de la
 * pasarela (lo más natural en soporte) o un contracargo perdido dejaban el pedido COMPLETED, el QR entrando y la venta sumando. Aquí está lo que el webhook
 * (`charge.refunded`, `charge.dispute.*`) hace con ellos, y la barredera que repara los pedidos REFUNDED que se quedaron con entradas activas.
 *
 * Reglas:
 *  - Un reembolso TOTAL anula el pedido igual que el del admin (pedido REFUNDED, entradas REFUNDED y aforo liberado; en tienda, stock repuesto salvo que ya
 *    se enviara), en UNA transacción, y avisa al comprador y al operador.
 *  - Uno PARCIAL no se puede repartir entre entradas o líneas (no hay precio por entrada), así que NO cambia nada: se avisa al operador con el importe.
 *  - Una disputa abierta solo avisa (todavía no se ha perdido nada y se puede ganar); perdida, se trata como reembolso total.
 *  - Todo es idempotente: la transición COMPLETED→REFUNDED es un compare-and-swap, así que solo UNA llamada anula y avisa; el reembolso del propio admin y su
 *    webhook posterior no se pisan (el pedido ya consta REFUNDED y el webhook no hace nada). */

type Kind = 'entradas' | 'tienda';

export type GatewayRefund = { orderId: string; full: boolean; refunded: number; total: number; source: 'refund' | 'dispute_lost' };
export type GatewayRefundOutcome = 'applied' | 'already' | 'partial_alerted' | 'inactive' | 'missing';

const money = (n: number) => `${Number(n).toFixed(2).replace('.', ',')} €`;
const SHOP_ACTIVE = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;
const refundMailMarker = (orderId: string) => `refund-mail:${orderId}`;

/** Email al comprador: su pedido consta reembolsado y las entradas/el pedido ya no valen. Una vez por pedido; un fallo de envío solo se registra. */
export async function sendRefundEmail(
  kind: Kind,
  order: { id: string; buyerName: string; buyerEmail: string },
  amount: number
): Promise<void> {
  const marker = refundMailMarker(order.id);
  try {
    // Se reclama ANTES de enviar y se libera si falla (como los demás avisos): dos entregas simultáneas no avisan dos veces.
    const claimed = await prisma.processedWebhookEvent.createMany({ data: [{ id: marker }], skipDuplicates: true });
    if (claimed.count === 0) return;
    try {
      const brand = await getBrand();
      const what = kind === 'entradas' ? 'Tus entradas ya no son válidas.' : 'Tu pedido ha quedado anulado.';
      const result = await sendMail({
        to: order.buyerEmail,
        subject: `Hemos registrado tu reembolso - ${brand.name}`,
        html:
          '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">' +
          brandLogoHtml(brand, getFallbackBaseUrl(), 32, 'margin:0 0 20px;') +
          `<p>Hola ${esc(order.buyerName)},</p>` +
          `<p>Se ha reembolsado <strong>${money(amount)}</strong> de tu pedido a tu método de pago original. ${what}</p>` +
          '<p>La devolución puede tardar unos días en aparecer, según tu banco.</p>' +
          `<p style="color:#666;">Referencia: ${esc(order.id.slice(0, 8).toUpperCase())}.</p>` +
          '</div>',
      });
      if (!result.success) throw new Error(result.error ?? 'envío fallido');
    } catch (error) {
      await prisma.processedWebhookEvent.deleteMany({ where: { id: marker } }).catch(() => {});
      logPaymentEvent('[gateway-refund]', { orderId: order.id, reason: 'buyer_email_failed', error: error instanceof Error ? error.message : String(error) });
    }
  } catch (error) {
    logPaymentEvent('[gateway-refund]', { orderId: order.id, reason: 'buyer_email_failed', error: error instanceof Error ? error.message : String(error) });
  }
}

/** Aviso al operador de algo que la pasarela ha hecho sin que lo pidiera la app. Una vez al día por pedido y motivo. */
async function notifyOperator(kind: Kind, orderId: string, reason: string, subject: string, html: string, details?: Record<string, unknown>) {
  await alertOperator({ kind, tag: '[gateway-refund]', orderId, reason, subject, html, dedupeKey: `${reason}:${orderId}`, ...(details ? { details } : {}) });
}

/** Aplica un reembolso (o contracargo perdido) hecho en la pasarela al pedido de la plataforma que nombra. */
export async function applyGatewayRefund(refund: GatewayRefund): Promise<GatewayRefundOutcome> {
  const order = await prisma.order.findUnique({ where: { id: refund.orderId }, include: { tickets: true } });
  if (order) return applyToOrder(order, refund);
  const shop = await prisma.shopOrder.findUnique({ where: { id: refund.orderId }, include: { items: true } });
  if (shop) return applyToShopOrder(shop, refund);
  return 'missing';
}

const originText = (r: GatewayRefund) => (r.source === 'dispute_lost' ? 'un contracargo (disputa) que se ha perdido' : 'un reembolso hecho en el panel de la pasarela');

async function partialAlert(kind: Kind, orderId: string, r: GatewayRefund, status: string) {
  await notifyOperator(
    kind,
    orderId,
    'partial_refund_in_gateway',
    `⚠️ Reembolso parcial hecho en la pasarela (${orderId.slice(0, 8)})`,
    `<p>La pasarela ha devuelto <strong>${money(r.refunded)}</strong> de <strong>${money(r.total)}</strong> del pedido${kind === 'tienda' ? ' de tienda' : ''} <strong>${esc(orderId)}</strong> (estado: ${esc(status)}).</p>` +
      '<p>No se ha cambiado nada en la plataforma: un reembolso parcial no se puede repartir entre entradas o líneas. Si hay que anular algo, hazlo a mano; las ventas y los ingresos de este pedido siguen contando por el importe completo.</p>',
    { refunded: r.refunded, total: r.total, status }
  );
}

async function applyToOrder(
  order: { id: string; status: string; buyerName: string; buyerEmail: string; tickets: { id: string; status: string; ticketTypeId: string | null }[] },
  r: GatewayRefund
): Promise<GatewayRefundOutcome> {
  if (!r.full) {
    await partialAlert('entradas', order.id, r, order.status);
    return 'partial_alerted';
  }
  if (order.status === 'REFUNDED' || order.status === 'CANCELLED') return 'already'; // lo hizo la app (o ya estaba anulado): el webhook solo confirma
  if (order.status !== 'COMPLETED') {
    await notifyOperator('entradas', order.id, 'refund_on_unpaid_order', `⚠️ Reembolso en la pasarela de un pedido sin pagar (${order.id.slice(0, 8)})`,
      `<p>La pasarela informa de ${esc(originText(r))} sobre el pedido <strong>${esc(order.id)}</strong>, que está en estado <strong>${esc(order.status)}</strong>. No se ha cambiado nada: revísalo a mano.</p>`);
    return 'inactive';
  }

  const applied = await prisma.$transaction(async (tx) => {
    const claim = await tx.order.updateMany({ where: { id: order.id, status: 'COMPLETED' }, data: { status: 'REFUNDED', idempotencyKey: null } });
    if (claim.count === 0) return null; // otra entrega (o el admin) ya lo anuló
    const active = await tx.ticket.findMany({ where: { orderId: order.id, status: { in: ['PENDING', 'VALID'] } }, select: { id: true, ticketTypeId: true } });
    await tx.ticket.updateMany({ where: { id: { in: active.map((t) => t.id) } }, data: { status: 'REFUNDED' } });
    const byType = new Map<string, number>();
    for (const t of active) if (t.ticketTypeId) byType.set(t.ticketTypeId, (byType.get(t.ticketTypeId) ?? 0) + 1);
    for (const [ticketTypeId, quantity] of byType) await tx.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { decrement: quantity } } });
    return { cancelled: active.length };
  });
  if (!applied) return 'already';

  const used = order.tickets.filter((t) => t.status === 'USED').length;
  logPaymentEvent('[gateway-refund]', { kind: 'entradas', orderId: order.id, reason: 'applied', source: r.source, cancelled: applied.cancelled, used }, 'warn');
  if (r.source === 'refund') await sendRefundEmail('entradas', order, r.refunded);
  await notifyOperator('entradas', order.id, 'refunded_in_gateway_applied', `Pedido reembolsado en la pasarela: entradas anuladas (${order.id.slice(0, 8)})`,
    `<p>La pasarela informa de ${esc(originText(r))} por <strong>${money(r.refunded)}</strong> sobre el pedido <strong>${esc(order.id)}</strong>.</p>` +
      `<p>El pedido se ha marcado como reembolsado y se han anulado <strong>${applied.cancelled}</strong> entrada(s)${used > 0 ? `; <strong>${used}</strong> ya había(n) entrado y no se puede deshacer` : ''}. ${r.source === 'refund' ? 'Se ha avisado al comprador.' : 'No se ha avisado al comprador (disputa).'}</p>`,
    { cancelled: applied.cancelled, used, source: r.source });
  return 'applied';
}

async function applyToShopOrder(
  order: { id: string; status: string; buyerName: string; buyerEmail: string; items: { productId: string; quantity: number; size: string | null; color: string | null }[] },
  r: GatewayRefund
): Promise<GatewayRefundOutcome> {
  if (!r.full) {
    await partialAlert('tienda', order.id, r, order.status);
    return 'partial_alerted';
  }
  if (order.status === 'REFUNDED' || order.status === 'CANCELLED') return 'already';
  if (!(SHOP_ACTIVE as readonly string[]).includes(order.status)) {
    await notifyOperator('tienda', order.id, 'refund_on_unpaid_order', `⚠️ Reembolso en la pasarela de un pedido sin pagar (${order.id.slice(0, 8)})`,
      `<p>La pasarela informa de ${esc(originText(r))} sobre el pedido de tienda <strong>${esc(order.id)}</strong>, que está en estado <strong>${esc(order.status)}</strong>. No se ha cambiado nada: revísalo a mano.</p>`);
    return 'inactive';
  }

  const before = order.status as (typeof SHOP_ACTIVE)[number];
  const returnsStock = refundReturnsStock(before);
  const applied = await prisma.$transaction(async (tx) => {
    const claim = await tx.shopOrder.updateMany({ where: { id: order.id, status: before }, data: { status: 'REFUNDED', idempotencyKey: null } });
    if (claim.count === 0) return false;
    if (returnsStock) {
      const { releaseShopStock } = await import('@/lib/product-stock');
      await releaseShopStock(tx, order.items.map((i) => ({ productId: i.productId, quantity: i.quantity, size: i.size, color: i.color })));
    }
    return true;
  });
  if (!applied) return 'already';

  logPaymentEvent('[gateway-refund]', { kind: 'tienda', orderId: order.id, reason: 'applied', source: r.source, restocked: returnsStock }, 'warn');
  if (r.source === 'refund') await sendRefundEmail('tienda', order, r.refunded);
  await notifyOperator('tienda', order.id, 'refunded_in_gateway_applied', `Pedido de tienda reembolsado en la pasarela (${order.id.slice(0, 8)})`,
    `<p>La pasarela informa de ${esc(originText(r))} por <strong>${money(r.refunded)}</strong> sobre el pedido de tienda <strong>${esc(order.id)}</strong>.</p>` +
      `<p>El pedido se ha marcado como reembolsado${returnsStock ? ' y se ha repuesto el stock' : '; el stock NO se ha repuesto porque la mercancía ya se había enviado'}. ${r.source === 'refund' ? 'Se ha avisado al comprador.' : 'No se ha avisado al comprador (disputa).'}</p>`,
    { restocked: returnsStock, source: r.source });
  return 'applied';
}

/** Disputa (contracargo) abierta sobre el cobro de un pedido: solo se avisa; aún se puede ganar y no se ha perdido dinero. false = el pedido no existe. */
export async function alertDisputeOpened(orderId: string, amount: number, reason?: string): Promise<boolean> {
  const ticketOrder = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
  const shopOrder = ticketOrder ? null : await prisma.shopOrder.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!ticketOrder && !shopOrder) return false;
  const isShop = !ticketOrder;
  await notifyOperator(
    isShop ? 'tienda' : 'entradas',
    orderId,
    'dispute_opened',
    `🚨 El comprador ha abierto una disputa de ${money(amount)} (${orderId.slice(0, 8)})`,
    `<p>El comprador del pedido${isShop ? ' de tienda' : ''} <strong>${esc(orderId)}</strong> ha abierto una disputa (contracargo) de <strong>${money(amount)}</strong>${reason ? ` (motivo: ${esc(reason)})` : ''}.</p>` +
      '<p>Todavía no se ha perdido el dinero y la disputa se puede ganar, así que NO se ha anulado nada. Responde con tus pruebas en el panel de la pasarela dentro del plazo que te dé. ' +
      'Si la pierdes, el pedido se marcará solo como reembolsado y se anularán sus entradas.</p>',
    { amount, reason: reason ?? null }
  );
  return true;
}

/** Un REFUNDED con entradas activas se considera «en vuelo» (el reembolso del admin marca el pedido ANTES de llamar a la pasarela) hasta pasado este tiempo. */
export const REFUND_REPAIR_MIN_AGE_MS = 15 * 60_000;

/**
 * Repara los pedidos REFUNDED que se quedaron con entradas activas: el proceso murió (o falló la BD) entre «pedido REFUNDED» y «entradas anuladas + aforo
 * liberado» (EN-08.1). El escáner ya las rechaza (P1-02), pero siguen contando como vendidas y ocupando aforo. Solo toca pedidos REFUNDED desde hace más de
 * `REFUND_REPAIR_MIN_AGE_MS`, para no pisar un reembolso que aún está en curso. Idempotente. Nunca lanza.
 */
export async function repairRefundedOrders(opts: { now?: number; limit?: number } = {}): Promise<{ repaired: number; tickets: number }> {
  let repaired = 0;
  let tickets = 0;
  try {
    const before = new Date((opts.now ?? Date.now()) - REFUND_REPAIR_MIN_AGE_MS);
    const stuck = await prisma.order.findMany({
      where: { status: 'REFUNDED', updatedAt: { lt: before }, tickets: { some: { status: { in: ['PENDING', 'VALID'] } } } },
      select: { id: true },
      take: opts.limit ?? 20,
      orderBy: { updatedAt: 'asc' },
    });
    for (const { id } of stuck) {
      try {
        const n = await prisma.$transaction(async (tx) => {
          // Releer DENTRO de la transacción y exigir que siga REFUNDED: si el reembolso se revirtió entre medias, no se toca nada.
          const current = await tx.order.findFirst({ where: { id, status: 'REFUNDED' }, select: { id: true } });
          if (!current) return 0;
          const active = await tx.ticket.findMany({ where: { orderId: id, status: { in: ['PENDING', 'VALID'] } }, select: { id: true, ticketTypeId: true } });
          if (active.length === 0) return 0;
          await tx.ticket.updateMany({ where: { id: { in: active.map((t) => t.id) } }, data: { status: 'REFUNDED' } });
          const byType = new Map<string, number>();
          for (const t of active) if (t.ticketTypeId) byType.set(t.ticketTypeId, (byType.get(t.ticketTypeId) ?? 0) + 1);
          for (const [ticketTypeId, quantity] of byType) await tx.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { decrement: quantity } } });
          return active.length;
        });
        if (n > 0) {
          repaired += 1;
          tickets += n;
          logPaymentEvent('[gateway-refund]', { kind: 'entradas', orderId: id, reason: 'zombie_repaired', tickets: n }, 'warn');
        }
      } catch (error) {
        logPaymentEvent('[gateway-refund]', { kind: 'entradas', orderId: id, reason: 'repair_failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    logPaymentEvent('[gateway-refund]', { reason: 'repair_sweep_failed', error: error instanceof Error ? error.message : String(error) });
  }
  return { repaired, tickets };
}
