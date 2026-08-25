import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Prisma } from '@prisma/client';
import { generateQRDataUrl } from '@/lib/qr';

type OrderForPdf = Prisma.OrderGetPayload<{
  include: { event: true; tickets: { include: { ticketType: true } } };
}>;

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

/**
 * Genera un PDF con una página por entrada (QR embebido).
 * Usa Helvetica estándar — sin tipografías externas.
 */
export async function buildTicketsPdf(order: OrderForPdf): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const eventDate = order.event?.date
    ? new Date(order.event.date).toLocaleDateString('es-ES', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'Europe/Madrid',
      })
    : '';

  for (const ticket of order.tickets ?? []) {
    const page = pdf.addPage([595.28, 841.89]); // A4
    const { width, height } = page.getSize();
    const margin = 48;
    let y = height - margin;

    const draw = (text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
      const size = opts.size ?? 12;
      const f = opts.bold ? fontBold : font;
      page.drawText(text, {
        x: margin,
        y,
        size,
        font: f,
        color: opts.color ?? rgb(0.1, 0.1, 0.1),
        maxWidth: width - margin * 2,
      });
      y -= size + 6;
    };

    draw('La Grailla', { size: 22, bold: true, color: rgb(0.55, 0.2, 0.85) });
    draw('Entrada digital', { size: 11, color: rgb(0.4, 0.4, 0.4) });
    y -= 12;

    draw(order.event?.name ?? 'Evento', { size: 16, bold: true });
    draw(`Fecha: ${eventDate}`, { size: 11 });
    draw(`Lugar: ${order.event?.venue ?? ''} — ${order.event?.city ?? ''}`, { size: 11 });
    if (order.event?.doorsOpen) {
      draw(`Apertura de puertas: ${order.event.doorsOpen}`, { size: 11 });
    }
    y -= 16;

    const qrDataUrl = await generateQRDataUrl(ticket.qrCode ?? '');
    const qrImage = await pdf.embedPng(dataUrlToBytes(qrDataUrl));
    const qrSize = 220;
    const qrX = (width - qrSize) / 2;
    page.drawImage(qrImage, { x: qrX, y: y - qrSize, width: qrSize, height: qrSize });
    y -= qrSize + 16;

    page.drawText(ticket.qrCode ?? '', {
      x: margin,
      y,
      size: 9,
      font,
      color: rgb(0.45, 0.45, 0.45),
      maxWidth: width - margin * 2,
    });
    y -= 28;

    draw(`Titular: ${ticket.holderName ?? ''}`, { size: 12, bold: true });
    draw(`Tipo: ${ticket.ticketType?.name ?? 'General'}`, { size: 11 });
    draw(`ID: ${(ticket.id ?? '').slice(0, 8)}`, { size: 11 });
    y -= 20;
    draw('Presenta este código QR en la entrada. No lo compartas.', {
      size: 9,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  return pdf.save();
}

const MM_TO_PT = 2.8346;
const ROLL_WIDTH_PT = 110 * MM_TO_PT; // rollo continuo de 110mm (Phomemo M832)
// Altura fija con margen de sobra: es un rollo continuo, no hace falta
// ajustar la altura al contenido exacto — el corte lo decide la app de
// impresión, no el tamaño de página del PDF.
const ROLL_HEIGHT_PT = 430;

type DrawOpts = { size?: number; bold?: boolean; center?: boolean; color?: ReturnType<typeof rgb> };

/**
 * Variante compacta de una sola columna para el rollo térmico de 110mm de la
 * Phomemo M832 — una página por entrada, QR grande a todo lo ancho para que
 * se escanee bien en puerta. Se comparte con la app Phomemo (ver
 * app/api/taquilla/print/[orderId]/route.ts) en vez de imprimirse como una
 * impresora de sistema, así que no hace falta encajar en un tamaño de papel
 * estándar.
 */
export async function buildTicketsPdfForRoll(order: OrderForPdf): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const eventDateShort = order.event?.date
    ? new Date(order.event.date).toLocaleDateString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Europe/Madrid',
      })
    : '';

  for (const ticket of order.tickets ?? []) {
    const page = pdf.addPage([ROLL_WIDTH_PT, ROLL_HEIGHT_PT]);
    const { width } = page.getSize();
    const margin = 14;
    let y = ROLL_HEIGHT_PT - margin;

    const draw = (text: string, opts: DrawOpts = {}) => {
      const size = opts.size ?? 9;
      const f = opts.bold ? fontBold : font;
      const textWidth = opts.center ? f.widthOfTextAtSize(text, size) : 0;
      page.drawText(text, {
        x: opts.center ? (width - textWidth) / 2 : margin,
        y,
        size,
        font: f,
        color: opts.color ?? rgb(0.1, 0.1, 0.1),
        maxWidth: width - margin * 2,
      });
      y -= size + 4;
    };

    draw('LA GRAILLA', { size: 13, bold: true, center: true, color: rgb(0.55, 0.2, 0.85) });
    y -= 2;
    draw(order.event?.name ?? 'Evento', { size: 10, bold: true, center: true });
    draw(eventDateShort, { size: 8, center: true, color: rgb(0.4, 0.4, 0.4) });
    if (order.event?.venue) {
      draw(order.event.venue, { size: 8, center: true, color: rgb(0.4, 0.4, 0.4) });
    }
    y -= 6;

    const qrDataUrl = await generateQRDataUrl(ticket.qrCode ?? '');
    const qrImage = await pdf.embedPng(dataUrlToBytes(qrDataUrl));
    const qrSize = width - margin * 2;
    const qrX = (width - qrSize) / 2;
    page.drawImage(qrImage, { x: qrX, y: y - qrSize, width: qrSize, height: qrSize });
    y -= qrSize + 10;

    draw(ticket.qrCode ?? '', { size: 7, center: true, color: rgb(0.5, 0.5, 0.5) });
    y -= 6;

    draw(ticket.holderName ?? '', { size: 9, bold: true, center: true });
    draw(ticket.ticketType?.name ?? 'General', { size: 8, center: true });
    draw(`ID ${(ticket.id ?? '').slice(0, 8)}`, { size: 7, center: true, color: rgb(0.5, 0.5, 0.5) });
  }

  return pdf.save();
}
