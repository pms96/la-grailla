import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { generateQRDataUrl } from '@/lib/qr';
import { sendMail } from '@/lib/mailer';
import { orderAccessQuery } from '@/lib/access-token';
import { buildTicketsPdf } from '@/lib/ticket-pdf';

type OrderWithTickets = Prisma.OrderGetPayload<{
  include: { event: true; tickets: { include: { ticketType: true } } };
}>;

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function buildTicketsHtml(orderId: string): Promise<{ html: string; order: OrderWithTickets } | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { event: true, tickets: { include: { ticketType: true } } },
  });
  if (!order) return null;

  const logoUrl = (process.env.NEXTAUTH_URL ?? '') + '/brand/logo-black.png';
  const eventDate = order.event?.date
    ? new Date(order.event.date).toLocaleDateString('es-ES', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'Europe/Madrid',
      })
    : '';

  const parts: string[] = [];
  for (const ticket of order.tickets ?? []) {
    const qrDataUrl = await generateQRDataUrl(ticket?.qrCode ?? '');
    parts.push(
      '<div style="page-break-after: always; padding: 40px; font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">' +
        '<div style="text-align:center;margin-bottom:30px;"><img src="' + logoUrl + '" alt="La Grailla" height="32" style="height:32px;width:auto;" />' +
        '<p style="color:#666;margin:5px 0;">Entrada Digital</p></div>' +
        '<div style="background:#f9fafb;border-radius:12px;padding:24px;margin-bottom:20px;">' +
        '<h2 style="margin:0 0 8px;color:#1a1a1a;">' + esc(order.event?.name) + '</h2>' +
        '<p style="margin:4px 0;color:#555;">Fecha: ' + esc(eventDate) + '</p>' +
        '<p style="margin:4px 0;color:#555;">Lugar: ' + esc(order.event?.venue) + ' - ' + esc(order.event?.city) + '</p>' +
        '<p style="margin:4px 0;color:#555;">Apertura de puertas: ' + esc(order.event?.doorsOpen) + '</p>' +
        '</div>' +
        '<div style="text-align:center;margin:30px 0;">' +
        '<img src="' + qrDataUrl + '" width="250" height="250" style="border:2px solid #e5e7eb;border-radius:8px;" />' +
        '<p style="font-family:monospace;font-size:12px;color:#999;margin-top:8px;">' + esc(ticket?.qrCode) + '</p></div>' +
        '<div style="background:#f3f0ff;border-radius:8px;padding:16px;">' +
        '<p style="margin:4px 0;"><strong>Titular:</strong> ' + esc(ticket?.holderName) + '</p>' +
        '<p style="margin:4px 0;"><strong>Tipo:</strong> ' + esc(ticket?.ticketType?.name ?? 'General') + '</p>' +
        '<p style="margin:4px 0;"><strong>ID:</strong> ' + esc(ticket?.id?.slice(0, 8)) + '</p></div>' +
        '<p style="text-align:center;font-size:11px;color:#aaa;margin-top:20px;">Presenta este codigo QR en la entrada del evento. No compartas este codigo.</p>' +
        '</div>'
    );
  }

  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Entradas</title></head><body style="margin:0;padding:0;">' +
    parts.join('') +
    '</body></html>';

  return { html, order };
}

function buildEmailHtml(order: OrderWithTickets, printUrl: string, logoUrl: string): string {
  const eventDate = order.event?.date
    ? new Date(order.event.date).toLocaleDateString('es-ES', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Europe/Madrid',
      })
    : '';
  const count = order.tickets?.length ?? 0;

  const cta =
    '<p style="text-align:center;margin:28px 0;"><a href="' +
    printUrl +
    '" style="background:#a855f7;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Ver e imprimir mis entradas</a></p>';

  return (
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">' +
    '<img src="' + logoUrl + '" alt="La Grailla" height="32" style="height:32px;width:auto;margin:0 0 4px;" />' +
    '<p style="color:#888;margin:0 0 24px;">Confirmacion de compra</p>' +
    '<p>Hola ' + esc(order.buyerName) + ',</p>' +
    '<p>Tu compra se ha completado correctamente. Aqui tienes los detalles:</p>' +
    '<div style="background:#f6f4ff;border-radius:10px;padding:18px;margin:18px 0;">' +
    '<p style="margin:4px 0;"><strong>Evento:</strong> ' + esc(order.event?.name) + '</p>' +
    '<p style="margin:4px 0;"><strong>Fecha:</strong> ' + esc(eventDate) + '</p>' +
    '<p style="margin:4px 0;"><strong>Lugar:</strong> ' + esc(order.event?.venue) + ' - ' + esc(order.event?.city) + '</p>' +
    '<p style="margin:4px 0;"><strong>Entradas:</strong> ' + count + '</p>' +
    '<p style="margin:4px 0;"><strong>Total:</strong> ' + Number(order.totalAmount ?? 0).toFixed(2) + ' EUR</p>' +
    '<p style="margin:4px 0;"><strong>Referencia:</strong> ' + esc(order.id?.slice(0, 8)?.toUpperCase()) + '</p>' +
    '</div>' +
    cta +
    '<p style="font-size:12px;color:#999;">Adjuntamos un PDF con tus entradas. Tambien puedes abrir el enlace de arriba para verlas e imprimirlas. No compartas tus codigos con nadie.</p>' +
    '</div>'
  );
}

const PUBLIC_RESEND_COOLDOWN_MS = 60_000;

export async function sendTicketsEmail(
  orderId: string,
  force: boolean = false,
  baseUrl?: string,
  options?: { softResend?: boolean }
) {
  const built = await buildTicketsHtml(orderId);
  if (!built) return { success: false, error: 'Pedido no encontrado' };
  const { order } = built;

  if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
    return { success: false, error: 'order_inactive' };
  }

  if (order.emailSentAt && !force) {
    if (options?.softResend) {
      const elapsed = Date.now() - new Date(order.emailSentAt).getTime();
      if (elapsed < PUBLIC_RESEND_COOLDOWN_MS) {
        return {
          success: true,
          alreadySent: true,
          cooldownMs: PUBLIC_RESEND_COOLDOWN_MS - elapsed,
        };
      }
      // Tras el cooldown, el comprador con la URL de confirmación puede reenviar.
    } else {
      return { success: true, alreadySent: true };
    }
  }

  // No enviar (ni PDF, ni QR válidos) mientras el pago siga pendiente de confirmar.
  if (order.status === 'PENDING') {
    return { success: false, error: 'pending_payment' };
  }

  const appUrl = baseUrl ?? process.env.NEXTAUTH_URL ?? '';
  const printUrl = appUrl + '/api/tickets/' + order.id + '/pdf-html?' + orderAccessQuery(order.id);
  const logoUrl = appUrl + '/brand/logo-black.png';

  let pdfBytes: Uint8Array | null = null;
  try {
    pdfBytes = await buildTicketsPdf(order);
  } catch (error) {
    console.error(
      `[sendTicketsEmail] PDF fallido para ${orderId}:`,
      error instanceof Error ? error.message : error
    );
  }

  const result = await sendMail({
    to: order.buyerEmail,
    subject: 'Tus entradas para ' + (order.event?.name ?? 'La Grailla'),
    html: buildEmailHtml(order, printUrl, logoUrl),
    attachments: pdfBytes
      ? [
          {
            filename: `entradas-${order.id.slice(0, 8)}.pdf`,
            content: Buffer.from(pdfBytes),
            contentType: 'application/pdf',
          },
        ]
      : undefined,
  });

  await prisma.order.update({
    where: { id: order.id },
    data: {
      emailAttempts: { increment: 1 },
      ...(result.success
        ? { emailSentAt: new Date(), emailLastError: null }
        : { emailLastError: result.error ?? 'Error desconocido al enviar' }),
    },
  });

  return { success: result.success, transport: result.transport, error: result.error };
}
