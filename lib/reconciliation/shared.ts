import { sendMail } from '@/lib/mailer';
import { getOperatorEmail } from '@/lib/config';
import { escapeHtml as esc } from '@/lib/html-escape';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rate-limit';
import { currentTenant } from '@/lib/tenant/context';

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

/** Log estructurado de pagos (una línea JSON tras una etiqueta greppable). Siempre con el cliente y sin datos personales. */
export function logPaymentEvent(tag: string, fields: Record<string, unknown>, level: 'error' | 'warn' | 'info' = 'error'): void {
  const line = `${tag} ${JSON.stringify({ tenantId: currentTenant()?.tenantId ?? '-', ...fields })}`;
  if (level === 'info') console.info(line);
  else if (level === 'warn') console.warn(line);
  else console.error(line);
}

/**
 * Único punto por el que el sistema avisa AL OPERADOR de algo que toca dinero (pago tardío, reembolso fallido, importe que no cuadra…).
 * Hoy sale por el canal que ya existe: un correo por el SMTP del cliente a su `admin_email` / `notify_email_<módulo>`, y siempre queda la
 * línea de log estructurada (el aviso NUNCA depende solo del correo). OB-02: el canal independiente del SMTP del cliente (ntfy/Slack del
 * panel) se enchufa aquí, en esta función y en ninguna otra. `dedupeKey` limita el correo a uno al día por clave (el cron reintenta cada
 * pocos minutos y no debe inundar la bandeja); el log sale siempre.
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
  try {
    if (params.dedupeKey) {
      const first = await rateLimit('operator-alert', params.dedupeKey, 1, 24 * 60 * 60 * 1000);
      if (!first.ok) return;
    }
    const to = await getOperatorEmail(params.kind);
    if (!to) return; // cliente sin admin_email: solo queda el log
    await sendMail({ to, subject: params.subject, html: params.html });
  } catch (error) {
    console.error(`${params.tag} No se pudo enviar el aviso al operador:`, error instanceof Error ? error.message : error);
  }
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
  if (currencyOk && Math.abs(paid.amount - expected) < 0.01) return true;

  console.error(
    `[order-reconciliation] El cobro de ${kind} ${orderId} no cuadra: la pasarela dice ${paid.amount} ${paid.currency ?? ''} y el pedido es de ${expected} EUR. No se completa.`
  );
  try {
    const first = await rateLimit('amount-mismatch', orderId, 1, 24 * 60 * 60 * 1000);
    const to = first.ok ? await getOperatorEmail(kind) : '';
    if (to) {
      await sendMail({
        to,
        subject: `⚠️ El importe cobrado no cuadra con el pedido (${orderId.slice(0, 8)})`,
        html:
          `<p>La pasarela confirma un pago de ${kind} para el pedido <strong>${esc(orderId)}</strong>, pero el importe no coincide.</p>` +
          `<p>Cobrado: <strong>${esc(String(paid.amount))} ${esc(paid.currency ?? '')}</strong> · Pedido: <strong>${esc(String(expected))} EUR</strong>.</p>` +
          `<p>El pedido NO se ha marcado como pagado. Revisa el cobro en la pasarela y decide si completarlo a mano o devolver el dinero.</p>`,
      });
    }
  } catch (error) {
    console.error('[paymentMatchesOrder] Error enviando alerta:', error instanceof Error ? error.message : error);
  }
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
