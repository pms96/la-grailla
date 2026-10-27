import { getFallbackBaseUrl } from '@/lib/url';
import { prisma } from '@/lib/prisma';
import { generateQRDataUrl } from '@/lib/qr';
import { sendMail } from '@/lib/mailer';
import { orderAccessQuery } from '@/lib/access-token';
import { buildTicketsPdf } from '@/lib/ticket-pdf';
import { buildMinorAuthorizationPdf } from '@/lib/minor-authorization-pdf';
import { getWalletAvailability, buildApplePass } from '@/lib/wallet';
import { escapeHtml as esc } from '@/lib/html-escape';
import { getBrand, type Brand } from '@/lib/brand/brand';
import { brandLogoHtml } from '@/lib/brand/email';

// DATA-01: derivado del propio `prisma` (extendido — totalAmount/commission
// son number, no Decimal), no de `Prisma.OrderGetPayload<...>` (que describe
// el cliente SIN extender y no coincidiría con la forma real devuelta abajo).
const orderWithTicketsInclude = { event: true, tickets: { include: { ticketType: true } } } as const;
type OrderWithTickets = NonNullable<
  Awaited<ReturnType<typeof prisma.order.findUnique<{ where: { id: string }; include: typeof orderWithTicketsInclude }>>>
>;

export async function buildTicketsHtml(orderId: string): Promise<{ html: string; order: OrderWithTickets } | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: orderWithTicketsInclude,
  });
  if (!order) return null;

  const brand = await getBrand();
  const logoHtml = brandLogoHtml(brand, undefined, 32);
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
        '<div style="text-align:center;margin-bottom:30px;">' + logoHtml +
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
        '<div style="background:' + brand.colors.emailTint + ';border-radius:8px;padding:16px;">' +
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

// Un botón-enlace por entrada y wallet disponible. Apple además se adjunta
// como .pkpass real en el email (ver sendTicketsEmail) — este enlace es el
// respaldo para quien no abra el adjunto, y la única vía posible para Google
// Wallet (que no tiene un formato de archivo adjuntable, solo el enlace
// firmado de "Guardar en Google Wallet").
function buildWalletLinksHtml(
  tickets: OrderWithTickets['tickets'],
  appUrl: string,
  orderId: string,
  wallet: { google: boolean; apple: boolean },
  brand: Brand
): string {
  if ((!wallet.google && !wallet.apple) || !tickets?.length) return '';
  const tokenQs = orderAccessQuery(orderId);
  const buttonStyle =
    'display:inline-block;margin:3px 6px 3px 0;padding:6px 12px;border-radius:999px;border:1px solid #1a1a1a;' +
    'color:#1a1a1a;text-decoration:none;font-size:12px;font-weight:600;';
  const rows = tickets
    .map((t) => {
      const links: string[] = [];
      if (wallet.apple) {
        links.push(
          `<a href="${appUrl}/api/wallet/apple/${t.id}?${tokenQs}" style="${buttonStyle}">Apple Wallet</a>`
        );
      }
      if (wallet.google) {
        links.push(
          `<a href="${appUrl}/api/wallet/google/${t.id}?${tokenQs}" style="${buttonStyle}">Google Wallet</a>`
        );
      }
      return (
        '<p style="margin:6px 0;font-size:13px;color:#333;"><strong>' +
        esc(t.holderName) +
        ':</strong><br/>' +
        links.join(' ') +
        '</p>'
      );
    })
    .join('');
  return (
    '<div style="background:' + brand.colors.emailTint + ';border-radius:8px;padding:14px;margin:18px 0;">' +
    '<p style="margin:0 0 8px;font-size:13px;color:#333;"><strong>Añade tus entradas a Wallet</strong> — las tendrás siempre a mano, incluso sin conexión.</p>' +
    rows +
    '</div>'
  );
}

function buildEmailHtml(
  order: OrderWithTickets,
  printUrl: string,
  brand: Brand,
  appUrl: string,
  minorAuthUrl?: string,
  walletLinksHtml?: string
): string {
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
    '" style="background:' + brand.colors.emailAccent + ';color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Ver e imprimir mis entradas</a></p>';

  const minorAuthNotice =
    order.event?.minorAuthorizationEnabled && minorAuthUrl
      ? '<div style="background:#fff8e6;border-radius:8px;padding:14px;margin:18px 0;border:1px solid #f0d98c;">' +
        '<p style="margin:0;font-size:13px;color:#7a5c00;"><strong>Asistentes de 16 y 17 anos:</strong> deben presentar en taquilla la autorizacion firmada por su padre/madre/tutor. Va adjunta en PDF.</p>' +
        '<p style="margin:6px 0 0;"><a href="' + minorAuthUrl + '" style="color:' + brand.colors.emailAccent + ';">Descargar autorizacion de menores (PDF)</a></p>' +
        '</div>'
      : '';

  return (
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">' +
    brandLogoHtml(brand, appUrl, 32, 'margin:0 0 4px;') +
    '<p style="color:#888;margin:0 0 24px;">Confirmacion de compra</p>' +
    '<p>Hola ' + esc(order.buyerName) + ',</p>' +
    '<p>Tu compra se ha completado correctamente. Aqui tienes los detalles:</p>' +
    '<div style="background:' + brand.colors.emailTint + ';border-radius:10px;padding:18px;margin:18px 0;">' +
    '<p style="margin:4px 0;"><strong>Evento:</strong> ' + esc(order.event?.name) + '</p>' +
    '<p style="margin:4px 0;"><strong>Fecha:</strong> ' + esc(eventDate) + '</p>' +
    '<p style="margin:4px 0;"><strong>Lugar:</strong> ' + esc(order.event?.venue) + ' - ' + esc(order.event?.city) + '</p>' +
    '<p style="margin:4px 0;"><strong>Entradas:</strong> ' + count + '</p>' +
    '<p style="margin:4px 0;"><strong>Total:</strong> ' + Number(order.totalAmount ?? 0).toFixed(2) + ' EUR</p>' +
    '<p style="margin:4px 0;"><strong>Referencia:</strong> ' + esc(order.id?.slice(0, 8)?.toUpperCase()) + '</p>' +
    '</div>' +
    minorAuthNotice +
    (walletLinksHtml ?? '') +
    cta +
    '<p style="font-size:12px;color:#999;">Adjuntamos un PDF con tus entradas. Tambien puedes abrir el enlace de arriba para verlas e imprimirlas. No compartas tus codigos con nadie.</p>' +
    '</div>'
  );
}

/**
 * Construye y envía el email con las entradas de un pedido (PDF, pases de Wallet, enlaces). NO lleva el estado de entrega ni decide si toca
 * enviar: eso es de `sendOrderEmail` (lib/order-email.ts), el ÚNICO punto de envío, que reclama la concesión antes y anota el resultado
 * después (lib/email-delivery.ts). Llamar a esto directamente se salta el reintento, la concesión y el rastro.
 */
export async function deliverTicketsEmail(
  orderId: string,
  baseUrl?: string
): Promise<{ success: boolean; transport?: string; error?: string; errorCode?: string }> {
  const built = await buildTicketsHtml(orderId);
  if (!built) return { success: false, error: 'Pedido no encontrado' };
  const { order } = built;

  if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
    return { success: false, error: 'order_inactive' };
  }

  // No enviar (ni PDF, ni QR válidos) mientras el pago siga pendiente de confirmar.
  if (order.status === 'PENDING') {
    return { success: false, error: 'pending_payment' };
  }

  const appUrl = baseUrl ?? getFallbackBaseUrl();
  const printUrl = appUrl + '/api/tickets/' + order.id + '/pdf-html?' + orderAccessQuery(order.id);
  const brand = await getBrand();
  const minorAuthUrl = order.event?.slug ? appUrl + '/api/events/' + order.event.slug + '/minor-authorization' : undefined;
  const wallet = await getWalletAvailability();
  const walletLinksHtml = buildWalletLinksHtml(order.tickets ?? [], appUrl, order.id, wallet, brand);

  let pdfBytes: Uint8Array | null = null;
  try {
    pdfBytes = await buildTicketsPdf(order);
  } catch (error) {
    console.error(
      `[deliverTicketsEmail] PDF fallido para ${orderId}:`,
      error instanceof Error ? error.message : error
    );
  }

  let minorAuthPdfBytes: Uint8Array | null = null;
  if (order.event?.minorAuthorizationEnabled) {
    try {
      minorAuthPdfBytes = await buildMinorAuthorizationPdf(order.event);
    } catch (error) {
      console.error(
        `[deliverTicketsEmail] PDF autorizacion fallido para ${orderId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // Se adjunta el .pkpass real por entrada (no solo un enlace): en Apple
  // Mail se ve al instante el botón nativo "Añadir a Wallet" sin salir del
  // email, y en cualquier otro cliente de iOS basta con abrir el adjunto —
  // el sistema reconoce el tipo de archivo. Un fallo puntual generando un
  // pase no debe tumbar el envío del resto de adjuntos ni del email.
  const applePassAttachments: { filename: string; content: Buffer; contentType: string }[] = [];
  if (wallet.apple && order.event) {
    for (const ticket of order.tickets ?? []) {
      try {
        const passBuffer = await buildApplePass({
          ticketId: ticket.id,
          eventId: ticket.eventId,
          qrCode: ticket.qrCode,
          holderName: ticket.holderName,
          eventName: order.event.name,
          venue: order.event.venue ?? '',
          city: order.event.city ?? '',
          date: order.event.date,
          ticketTypeName: ticket.ticketType?.name ?? 'General',
          eventImageUrl: order.event.imageUrl,
        });
        if (passBuffer) {
          applePassAttachments.push({
            filename: `apple-wallet-${ticket.id.slice(0, 8)}.pkpass`,
            content: passBuffer,
            contentType: 'application/vnd.apple.pkpass',
          });
        }
      } catch (error) {
        console.error(
          `[deliverTicketsEmail] Pase Apple Wallet fallido para ticket ${ticket.id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  const attachments = [
    ...(pdfBytes
      ? [{ filename: `entradas-${order.id.slice(0, 8)}.pdf`, content: Buffer.from(pdfBytes), contentType: 'application/pdf' }]
      : []),
    ...(minorAuthPdfBytes
      ? [
          {
            filename: `autorizacion-menores-${order.event?.slug ?? 'evento'}.pdf`,
            content: Buffer.from(minorAuthPdfBytes),
            contentType: 'application/pdf',
          },
        ]
      : []),
    ...applePassAttachments,
  ];

  const result = await sendMail({
    to: order.buyerEmail,
    subject: 'Tus entradas para ' + (order.event?.name ?? brand.name),
    html: buildEmailHtml(order, printUrl, brand, appUrl, minorAuthUrl, walletLinksHtml),
    attachments: attachments.length ? attachments : undefined,
  });

  return { success: result.success, transport: result.transport, error: result.error, errorCode: result.errorCode };
}
