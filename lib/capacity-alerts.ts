import { prisma } from '@/lib/prisma';
import { getConfig } from '@/lib/config';
import { sendMail } from '@/lib/mailer';

// Entradas emitidas (no ancladas ni reembolsadas) para un evento: usado para evitar
// sobreventa. Distinto de `Event.currentCount`, que representa a las personas que
// físicamente han entrado (escaneadas en la puerta), no las vendidas.
export async function getIssuedTicketCount(eventId: string): Promise<number> {
  return prisma.ticket.count({
    where: { eventId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
  });
}

/**
 * Alertas de aforo por **entradas emitidas** (preventa / taquilla), no por
 * personas dentro. Así se avisa de "casi agotado" durante la venta online.
 * Los umbrales y alertsSent viven en el evento; son independientes del aforo
 * en puerta (currentCount), que se monitoriza en /admin/aforo y /acceso.
 */
export async function checkCapacityAlerts(eventId: string) {
  try {
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return;

    const capacity = event.maxCapacity || 0;
    if (capacity <= 0) return;

    const thresholds = (event.alertThresholds || '80,95,100')
      .split(',')
      .map((t) => parseInt(t.trim(), 10))
      .filter((t) => !isNaN(t) && t > 0)
      .sort((a, b) => a - b);

    const alreadySent = (event.alertsSent || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const sold = await getIssuedTicketCount(eventId);
    const percent = Math.round((sold / capacity) * 100);
    const pending = thresholds.filter((t) => percent >= t && !alreadySent.includes(String(t)));
    if (!pending.length) return;

    const adminEmail = await getConfig('admin_email');
    if (!adminEmail) return;

    const highest = pending[pending.length - 1];
    const html =
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">' +
      '<h2 style="color:#a855f7;margin:0 0 12px;">Alerta de aforo (ventas)</h2>' +
      '<p>El evento <strong>' +
      event.name +
      '</strong> ha alcanzado el <strong>' +
      percent +
      '%</strong> de entradas emitidas sobre aforo.</p>' +
      '<div style="background:#f6f4ff;border-radius:10px;padding:16px;margin:16px 0;">' +
      '<p style="margin:4px 0;">Entradas emitidas: <strong>' +
      sold +
      '</strong></p>' +
      '<p style="margin:4px 0;">Dentro ahora: <strong>' +
      (event.currentCount || 0) +
      '</strong></p>' +
      '<p style="margin:4px 0;">Aforo maximo: <strong>' +
      capacity +
      '</strong></p>' +
      '<p style="margin:4px 0;">Umbral superado: <strong>' +
      highest +
      '%</strong></p>' +
      '</div>' +
      '<p style="font-size:12px;color:#999;">Puedes ajustar los umbrales desde el panel de administracion.</p>' +
      '</div>';

    const result = await sendMail({
      to: adminEmail,
      subject: 'Ventas al ' + percent + '% del aforo - ' + event.name,
      html,
    });

    if (result.success) {
      const merged = Array.from(new Set([...alreadySent, ...pending.map(String)])).join(',');
      await prisma.event.update({ where: { id: eventId }, data: { alertsSent: merged } });
    }
  } catch (error) {
    console.error('Capacity alert error:', error instanceof Error ? error.message : error);
  }
}
