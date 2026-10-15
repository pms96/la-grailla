import { sendMail } from '@/lib/mailer';
import { getOperatorEmail } from '@/lib/config';
import { escapeHtml as esc } from '@/lib/html-escape';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rate-limit';

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

/** Avisa al equipo cuando un pago se confirma sobre un pedido que ya fue cancelado/liberado — requiere intervención manual (el stock ya pudo venderse a otra persona). */
export async function alertPaidButInactiveOrder(kind: 'entradas' | 'tienda', orderId: string, status: string): Promise<void> {
  console.error(`[order-reconciliation] Pago confirmado para pedido de ${kind} ${orderId} pero su estado ya era ${status} — requiere revisión manual.`);
  try {
    const to = await getOperatorEmail(kind);
    if (!to) return; // cliente sin admin_email: solo queda el log
    await sendMail({
      to,
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

