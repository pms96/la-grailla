import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { getOperatorEmail } from '@/lib/config';
import { escapeHtml as esc } from '@/lib/html-escape';
import { getBrand } from '@/lib/brand/brand';
import { brandLogoHtml } from '@/lib/brand/email';
import { shopOrderAccessQuery } from '@/lib/access-token';
import { getFallbackBaseUrl } from '@/lib/url';
import { SHOP_PAID_STATUSES } from '@/lib/email-delivery';

/* Avisos de la tienda que no son la confirmación al comprador (auditoría P1-10 / TI-06 y TI-16):
 *   · al VENDEDOR, un email por pedido nuevo pagado (líneas con talla y color, comprador, dirección de envío): antes solo se enteraba mirando el panel;
 *   · al COMPRADOR, un email cuando el pedido pasa a «Enviado», con el número de seguimiento y el enlace a su pedido.
 * Ambos son IDEMPOTENTES con filas marcadoras de ProcessedWebhookEvent (se reclaman ANTES de enviar y se liberan si el envío falla), igual que los avisos
 * de cancelación de evento. El del vendedor además lo recupera el barrido del cron si el envío inmediato falló (lib/order-email.ts hace lo mismo con la
 * confirmación). Nunca lanzan: un aviso no puede tumbar el cobro ni el cambio de estado. */

const NEW_ORDER_PREFIX = 'shop-new-order-notice:';
const SHIPPED_PREFIX = 'shop-shipped-mail:';
const SINCE_KEY = 'shop_new_order_notice_since';
/** Hasta cuándo se reintenta un aviso de pedido nuevo que no salió (después, el vendedor ya lo habrá visto en el panel). */
const NOTICE_RETRY_WINDOW_MS = 48 * 3600_000;
const DEFAULT_CAP_MS = 15_000;

const money = (n: number) => `${Number(n).toFixed(2).replace('.', ',')} €`;

type NoticeItem = { quantity: number; unitPrice: number; size: string | null; color: string | null; product: { name: string } | null };

function shell(brand: Awaited<ReturnType<typeof getBrand>>, baseUrl: string, title: string, body: string): string {
  return (
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:8px;">` +
    brandLogoHtml(brand, baseUrl, 28, 'margin:0 0 12px;') +
    `<h2 style="color:${brand.colors.emailAccent};margin:0 0 12px;">${esc(title)}</h2>` +
    body +
    `<p style="margin-top:28px;font-size:12px;color:#888;">${esc(brand.name)}</p></div>`
  );
}

const button = (href: string, label: string, color: string) =>
  `<p style="margin:20px 0;"><a href="${esc(href)}" style="background:${color};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">${esc(label)}</a></p>`;

function itemsTable(items: NoticeItem[]): string {
  const rows = items
    .map((i) => {
      const variant = [i.size, i.color].filter(Boolean).join(' · ');
      return (
        `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${esc(i.product?.name ?? 'Producto')}` +
        (variant ? `<br/><span style="font-size:12px;color:#666;">${esc(variant)}</span>` : '') +
        `</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${Number(i.quantity ?? 0)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${esc(money(i.unitPrice ?? 0))}</td></tr>`
      );
    })
    .join('');
  return (
    `<table style="width:100%;border-collapse:collapse;"><tr style="background:#f3f4f6;"><th style="padding:8px;text-align:left;">Producto</th>` +
    `<th style="padding:8px;">Cant.</th><th style="padding:8px;text-align:right;">Precio</th></tr>${rows}</table>`
  );
}

/** El email al vendedor de un pedido nuevo. Todo lo que escribió el comprador va escapado. */
export function shopNewOrderEmailHtml(
  order: {
    id: string;
    buyerName: string;
    buyerEmail: string;
    shippingAddress: string;
    shippingCity: string;
    shippingZip: string;
    shippingPhone: string | null;
    totalAmount: number;
    items: NoticeItem[];
  },
  brand: Awaited<ReturnType<typeof getBrand>>,
  baseUrl: string
): string {
  return shell(
    brand,
    baseUrl,
    'Pedido nuevo en la tienda',
    `<p>Pedido <strong>#${esc(order.id.slice(0, 8))}</strong>, ya pagado: toca prepararlo y enviarlo.</p>` +
      itemsTable(order.items) +
      `<p style="font-size:18px;font-weight:bold;margin:16px 0;">Total: ${esc(money(order.totalAmount))}</p>` +
      `<p style="margin:0 0 4px;"><strong>Comprador:</strong> ${esc(order.buyerName)} · ${esc(order.buyerEmail)}${order.shippingPhone ? ` · ${esc(order.shippingPhone)}` : ''}</p>` +
      `<p style="margin:0;"><strong>Enviar a:</strong> ${esc(order.shippingAddress)}, ${esc(order.shippingZip)} ${esc(order.shippingCity)}</p>` +
      button(`${baseUrl}/admin/pedidos`, 'Abrir pedidos', brand.colors.emailAccent)
  );
}

/** El email al comprador cuando su pedido sale. Con número de seguimiento si ya hay, y siempre con el enlace a su pedido. */
export function shopShippedEmailHtml(
  order: { id: string; buyerName: string; trackingNumber: string | null; items: NoticeItem[] },
  brand: Awaited<ReturnType<typeof getBrand>>,
  baseUrl: string
): string {
  const orderUrl = `${baseUrl}/tienda/confirmacion/${order.id}?${shopOrderAccessQuery(order.id)}`;
  const tracking = (order.trackingNumber ?? '').trim();
  return shell(
    brand,
    baseUrl,
    'Tu pedido está en camino',
    `<p>Hola ${esc(order.buyerName)},</p>` +
      `<p>Tu pedido <strong>#${esc(order.id.slice(0, 8))}</strong> ya ha salido.</p>` +
      (tracking ? `<p style="margin:12px 0;"><strong>Seguimiento:</strong> ${esc(tracking)}</p>` : '<p style="color:#666;">Todavía no tenemos un número de seguimiento: si lo hay, te lo enviaremos.</p>') +
      itemsTable(order.items) +
      button(orderUrl, 'Ver mi pedido', brand.colors.emailAccent)
  );
}

type SendOutcome = { success: boolean; error?: string };

/** Envío con tope duro de tiempo (el SMTP tiene timeouts de inactividad, pero no uno total). */
async function sendCapped(payload: Parameters<typeof sendMail>[0], capMs: number): Promise<SendOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sendMail(payload).then((r): SendOutcome => ({ success: r.success, error: r.error })),
      new Promise<SendOutcome>((resolve) => (timer = setTimeout(() => resolve({ success: false, error: 'el envío no terminó a tiempo' }), capMs))),
    ]);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type NoticeResult = 'sent' | 'skipped' | 'failed' | 'no_recipient' | 'not_applicable';

/**
 * Avisa al vendedor de un pedido nuevo pagado. Destinatario: `notify_email_tienda` o, si está vacío, el email de administración del cliente. Sin
 * destinatario no se envía ni se anota nada (si lo configura después, el barrido de las últimas 48 h lo recupera).
 */
export async function notifyShopNewOrder(orderId: string, opts: { capMs?: number } = {}): Promise<NoticeResult> {
  try {
    const order = await prisma.shopOrder.findUnique({ where: { id: orderId }, include: { items: { include: { product: true } } } });
    if (!order || !(SHOP_PAID_STATUSES as readonly string[]).includes(order.status)) return 'not_applicable';
    const to = (await getOperatorEmail('tienda')).trim();
    if (!to) return 'no_recipient';
    const marker = `${NEW_ORDER_PREFIX}${orderId}`;
    const claim = await prisma.processedWebhookEvent.createMany({ data: [{ id: marker }], skipDuplicates: true });
    if (claim.count === 0) return 'skipped';
    const brand = await getBrand();
    const baseUrl = getFallbackBaseUrl();
    const sent = await sendCapped(
      { to, subject: `Pedido nuevo #${order.id.slice(0, 8)} · ${money(Number(order.totalAmount))}`, html: shopNewOrderEmailHtml({ ...order, totalAmount: Number(order.totalAmount), items: order.items.map((i) => ({ ...i, unitPrice: Number(i.unitPrice) })) }, brand, baseUrl) },
      opts.capMs ?? DEFAULT_CAP_MS
    );
    if (sent.success) return 'sent';
    await prisma.processedWebhookEvent.deleteMany({ where: { id: marker } });
    console.error('[shop-notices] no se pudo avisar del pedido nuevo:', (sent.error ?? 'error').slice(0, 160));
    return 'failed';
  } catch (error) {
    console.error('[shop-notices] error en el aviso de pedido nuevo:', error instanceof Error ? error.message : error);
    return 'failed';
  }
}

/** Desde cuándo se barren avisos pendientes: nunca antes de la primera pasada con esta función (los pedidos ya pagados al desplegar no se avisan de golpe). */
async function noticeSince(): Promise<number> {
  const row = await prisma.appConfig.findUnique({ where: { key: SINCE_KEY }, select: { value: true } });
  let installed = Number(row?.value);
  if (!Number.isFinite(installed) || installed <= 0) {
    installed = Date.now();
    await prisma.appConfig.upsert({ where: { key: SINCE_KEY }, update: {}, create: { key: SINCE_KEY, value: String(installed), label: SINCE_KEY, group: 'system' } });
  }
  return Math.max(installed, Date.now() - NOTICE_RETRY_WINDOW_MS);
}

/** Reintenta los avisos de pedido nuevo que no salieron (SMTP caído, función cortada). Lo llama el cron. Nunca lanza. */
export async function sweepShopNewOrderNotices(opts: { deadline: number; limit?: number }): Promise<{ examined: number; sent: number; failed: number }> {
  const out = { examined: 0, sent: 0, failed: 0 };
  try {
    const since = new Date(await noticeSince());
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT o."id" FROM "ShopOrder" o
      JOIN "ProcessedWebhookEvent" d ON d."id" = ${'email:shop:'}::text || o."id" || ${':due'}::text
      WHERE o."status"::text = ANY(${[...SHOP_PAID_STATUSES]}::text[]) AND d."processedAt" >= ${since}
        AND NOT EXISTS (SELECT 1 FROM "ProcessedWebhookEvent" p WHERE p."id" = ${NEW_ORDER_PREFIX}::text || o."id")
      ORDER BY d."processedAt" ASC
      LIMIT ${opts.limit ?? 5}`;
    for (const row of rows) {
      if (Date.now() >= opts.deadline) break;
      out.examined += 1;
      const result = await notifyShopNewOrder(row.id, { capMs: Math.max(1_000, Math.min(DEFAULT_CAP_MS, opts.deadline - Date.now())) });
      if (result === 'sent') out.sent += 1;
      else if (result === 'failed') out.failed += 1;
      // Sin destinatario configurado no hay nada que hacer en ninguno: se deja el resto para cuando lo haya.
      else if (result === 'no_recipient') break;
    }
  } catch (error) {
    console.error('[shop-notices] error en el barrido de avisos de pedido nuevo:', error instanceof Error ? error.message : error);
  }
  return out;
}

const trackingTag = (tracking: string | null) => createHash('sha1').update((tracking ?? '').trim()).digest('hex').slice(0, 12);

/**
 * Avisa al comprador de que su pedido ha salido. Una vez por número de seguimiento: al pasar a «Enviado» (con o sin número) y, si el número llega o
 * cambia después, otra vez con el nuevo. `force` (el botón del admin) vuelve a enviarlo aunque ya conste.
 */
export async function sendShopShippedEmail(orderId: string, opts: { force?: boolean; capMs?: number } = {}): Promise<NoticeResult> {
  try {
    const order = await prisma.shopOrder.findUnique({ where: { id: orderId }, include: { items: { include: { product: true } } } });
    if (!order || order.status !== 'SHIPPED') return 'not_applicable';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.buyerEmail)) return 'no_recipient';
    const marker = `${SHIPPED_PREFIX}${orderId}:${trackingTag(order.trackingNumber)}`;
    if (opts.force) await prisma.processedWebhookEvent.deleteMany({ where: { id: marker } });
    const claim = await prisma.processedWebhookEvent.createMany({ data: [{ id: marker }], skipDuplicates: true });
    if (claim.count === 0) return 'skipped';
    const brand = await getBrand();
    const operator = (await getOperatorEmail('tienda').catch(() => '')).trim();
    const sent = await sendCapped(
      {
        to: order.buyerEmail,
        subject: `Tu pedido está en camino - ${brand.name} #${order.id.slice(0, 8)}`,
        html: shopShippedEmailHtml({ ...order, items: order.items.map((i) => ({ ...i, unitPrice: Number(i.unitPrice) })) }, brand, getFallbackBaseUrl()),
        ...(operator ? { replyTo: operator } : {}),
      },
      opts.capMs ?? DEFAULT_CAP_MS
    );
    if (sent.success) return 'sent';
    await prisma.processedWebhookEvent.deleteMany({ where: { id: marker } });
    console.error('[shop-notices] no se pudo enviar el aviso de envío:', (sent.error ?? 'error').slice(0, 160));
    return 'failed';
  } catch (error) {
    console.error('[shop-notices] error en el aviso de envío:', error instanceof Error ? error.message : error);
    return 'failed';
  }
}
