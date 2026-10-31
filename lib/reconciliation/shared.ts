import { sendMail } from '@/lib/mailer';
import { getOperatorEmail } from '@/lib/config';
import { escapeHtml as esc } from '@/lib/html-escape';
import { prisma } from '@/lib/prisma';
import { rateLimit, resetRateLimit } from '@/lib/rate-limit';
import { currentTenant } from '@/lib/tenant/context';
import { sendPlatformAlert } from '@/lib/observability/platform-alert';
import { toCents } from '@/lib/pricing';

/** Qué ha pasado al confirmar un pago sobre un pedido (ver completeOrder / completeShopOrder). */
export type CompleteOutcome =
  /** Pedido pendiente que pasa a pagado ahora. */
  | 'completed'
  /** Ya estaba pagado: no se transiciona, pero se sigue el camino de entrega por si el primer envío falló. */
  | 'already_completed'
  /** Pago tardío: el pedido estaba CANCELLED (liberado o anulado) y había plazas/stock: reactivado y entregado. */
  | 'revived'
  /** Pago tardío sin plazas/stock: reembolsado por completo, pedido REFUNDED. */
  | 'refunded_late'
  /** Pago tardío que no se ha podido resolver (reembolso fallido, pago no verificable): el pedido queda para revisión y ya se ha avisado. */
  | 'late_unresolved'
  /** El importe cobrado no cuadra con el pedido: no se completa (ya se ha avisado). */
  | 'amount_mismatch'
  /** El pedido está en un estado en el que no procede (p. ej. REFUNDED): solo se avisa. */
  | 'inactive'
  | 'missing';

/** Ventana de la clave de idempotencia del reembolso (TI-09). */
export const REFUND_KEY_WINDOW_MS = 10 * 60_000;

/**
 * Clave de idempotencia del reembolso de un pedido. Antes era `refund_<pedido>` a secas: Stripe guarda y REPITE 24 h el resultado de la primera petición con
 * una clave, incluidos los errores 4xx, así que un primer intento fallido por algo corregible (saldo insuficiente en una cuenta nueva…) dejaba el reembolso
 * imposible un día entero. Con una ventana de 10 minutos, un timeout y su reintento inmediato siguen compartiendo clave (no se duplica nada) y, pasada la
 * ventana, un reintento ya corregido funciona; si el primero SÍ llegó, Stripe responde «ya reembolsado» y el adaptador lo da por bueno.
 */
export function refundIdempotencyKey(orderId: string, now = Date.now()): string {
  return `refund_${orderId}_${Math.floor(now / REFUND_KEY_WINDOW_MS)}`;
}

/** Log estructurado de pagos (una línea JSON tras una etiqueta greppable). Siempre con el cliente y sin datos personales. */
export function logPaymentEvent(tag: string, fields: Record<string, unknown>, level: 'error' | 'warn' | 'info' = 'error'): void {
  const line = `${tag} ${JSON.stringify({ tenantId: currentTenant()?.tenantId ?? '-', ...fields })}`;
  if (level === 'info') console.info(line);
  else if (level === 'warn') console.warn(line);
  else console.error(line);
}

/**
 * Único punto por el que el sistema avisa AL OPERADOR de algo que toca dinero (pago tardío, reembolso fallido, importe que no cuadra…).
 * Sale por DOS canales independientes, en paralelo, y uno nunca depende del otro (OB-02):
 *  1. un correo por el SMTP del cliente a su `admin_email` / `notify_email_<módulo>`;
 *  2. el canal de la plataforma (`PLATFORM_ALERT_URL`: ntfy/webhook del operador, sin SMTP ni `admin_email`), ver lib/observability/platform-alert.ts.
 * Siempre queda además la línea de log estructurada. Si el SMTP falla, o el cliente no tiene `admin_email`, el canal de la plataforma se
 * intenta igual; y si el canal de la plataforma falla o no está configurado, el correo sale como siempre. `dedupeKey` limita el aviso a uno al
 * día por clave (el cron reintenta cada pocos minutos y no debe inundar ni la bandeja ni el móvil); el log sale siempre. Si falla la
 * consulta del límite, se avisa igualmente: es preferible un aviso repetido a uno perdido.
 */
export async function alertOperator(params: {
  kind: 'entradas' | 'tienda';
  /** Etiqueta del log, p. ej. `[late-payment]`. */
  tag: string;
  orderId: string;
  /** Motivo corto, en snake_case, para buscar en logs (`refund_failed`, `paid_but_inactive`…). */
  reason: string;
  subject: string;
  /** Cuerpo HTML ya escapado. */
  html: string;
  dedupeKey?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  logPaymentEvent(params.tag, { kind: params.kind, orderId: params.orderId, reason: params.reason, ...(params.details ?? {}) });
  if (params.dedupeKey) {
    try {
      const first = await rateLimit('operator-alert', params.dedupeKey, 1, 24 * 60 * 60 * 1000);
      if (!first.ok) return;
    } catch (error) {
      console.error(`${params.tag} No se pudo comprobar el límite de avisos (se avisa igualmente):`, error instanceof Error ? error.message : error);
    }
  }
  const byEmail = async (): Promise<boolean> => {
    try {
      const to = await getOperatorEmail(params.kind);
      if (!to) return false; // cliente sin admin_email: queda el log y el canal de la plataforma
      const sent = await sendMail({ to, subject: params.subject, html: params.html });
      return sent.success === true;
    } catch (error) {
      console.error(`${params.tag} No se pudo enviar el aviso al operador:`, error instanceof Error ? error.message : error);
      return false;
    }
  };
  // En paralelo y cada uno a prueba de fallos (ninguno lanza): el comprador y el webhook nunca esperan por un canal caído más de su tiempo máximo.
  const [mail, platform] = await Promise.allSettled([byEmail(), sendPlatformAlert({ kind: params.kind, reason: params.reason, orderId: params.orderId })]);
  const delivered = (mail.status === 'fulfilled' && mail.value) || (platform.status === 'fulfilled' && platform.value === 'sent');
  // H-116: el cupo de 24 h se tomó antes de enviar. Si no salió por ningún canal, se devuelve: el cron reintenta cada 5 min y no debe quedar mudo un día entero.
  if (params.dedupeKey && !delivered) await resetRateLimit('operator-alert', params.dedupeKey);
}

/** Lo que la pasarela dice haber cobrado (ver `PaymentResult`). Ausente = no se puede contrastar. */
export type PaidInfo = { amount?: number; currency?: string };

/**
 * ¿Cuadra lo cobrado con el total del pedido? Antes se daba un pedido por pagado solo porque la pasarela dijera "pagado": un cobro de
 * 1 € sobre un pedido de 25 € se aceptaba. Si la pasarela no informa del importe (p. ej. la simulada) se mantiene el comportamiento de
 * siempre. Si no cuadra, el pedido NO se completa y se avisa al operador (como mucho una vez al día por pedido: el cron reintenta
 * cada 5 minutos y no debe inundar el correo).
 */
export async function paymentMatchesOrder(kind: 'entradas' | 'tienda', orderId: string, paid?: PaidInfo): Promise<boolean> {
  if (!paid || typeof paid.amount !== 'number') return true;
  const row =
    kind === 'entradas'
      ? await prisma.order.findUnique({ where: { id: orderId }, select: { totalAmount: true } })
      : await prisma.shopOrder.findUnique({ where: { id: orderId }, select: { totalAmount: true } });
  if (!row) return true; // el llamante ya gestiona un pedido inexistente
  const expected = Number(row.totalAmount);
  const currencyOk = !paid.currency || paid.currency.toUpperCase() === 'EUR';
  // Tolerancia explícita de UN céntimo, en enteros (con flotantes, `< 0.01` fallaba por 1e-15 según el caso: P1-07).
  if (currencyOk && Math.abs(toCents(paid.amount) - toCents(expected)) <= 1) return true;

  console.error(
    `[order-reconciliation] El cobro de ${kind} ${orderId} no cuadra: la pasarela dice ${paid.amount} ${paid.currency ?? ''} y el pedido es de ${expected} EUR. No se completa.`
  );
  // Como mucho un aviso al día por pedido (el cron reintenta cada 5 minutos). Por el mismo canal doble que el resto de avisos de dinero.
  await alertOperator({
    kind,
    tag: '[order-reconciliation]',
    orderId,
    reason: 'amount_mismatch',
    dedupeKey: `amount-mismatch:${orderId}`,
    subject: `⚠️ El importe cobrado no cuadra con el pedido (${orderId.slice(0, 8)})`,
    html:
      `<p>La pasarela confirma un pago de ${kind} para el pedido <strong>${esc(orderId)}</strong>, pero el importe no coincide.</p>` +
      `<p>Cobrado: <strong>${esc(String(paid.amount))} ${esc(paid.currency ?? '')}</strong> · Pedido: <strong>${esc(String(expected))} EUR</strong>.</p>` +
      `<p>El pedido NO se ha marcado como pagado. Revisa el cobro en la pasarela y decide si completarlo a mano o devolver el dinero.</p>`,
  });
  return false;
}

/** Avisa al equipo cuando un pago se confirma sobre un pedido en un estado en el que no procede (REFUNDED…): requiere intervención manual. */
export async function alertPaidButInactiveOrder(kind: 'entradas' | 'tienda', orderId: string, status: string): Promise<void> {
  await alertOperator({
    kind,
    tag: '[late-payment]',
    orderId,
    reason: 'paid_but_inactive',
    details: { status },
    dedupeKey: `paid-inactive:${orderId}:${status}`,
    subject: `⚠️ Pago confirmado sobre pedido ya anulado (${orderId.slice(0, 8)})`,
    html:
      `<p>Se ha confirmado un pago de ${kind} para el pedido <strong>${esc(orderId)}</strong>, ` +
      `pero su estado ya era <strong>${esc(status)}</strong>.</p>` +
      `<p>Revisa el cobro en la pasarela y contacta con el comprador si es necesario.</p>`,
  });
}
