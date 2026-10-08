import { sendMail } from '@/lib/mailer';
import { getOperatorEmail } from '@/lib/config';
import { escapeHtml as esc } from '@/lib/html-escape';

/** Avisa al equipo cuando un pago se confirma sobre un pedido que ya fue cancelado/liberado — requiere intervención manual (el stock ya pudo venderse a otra persona). */
export async function alertPaidButInactiveOrder(kind: 'entradas' | 'tienda', orderId: string, status: string): Promise<void> {
  console.error(`[order-reconciliation] Pago confirmado para pedido de ${kind} ${orderId} pero su estado ya era ${status} — requiere revisión manual.`);
  try {
    const to = await getOperatorEmail();
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

