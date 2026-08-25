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
