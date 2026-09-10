import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { prisma } from '@/lib/prisma';
import { readFile } from 'fs/promises';
import path from 'path';
import { generateQRDataUrl } from '@/lib/qr';

// DATA-01: derivado del propio cliente extendido (totalAmount/commission son
// number, no Decimal) — ver la misma nota en lib/tickets.ts.
type OrderForPdf = NonNullable<
  Awaited<
    ReturnType<
      typeof prisma.order.findUnique<{
        where: { id: string };
        include: { event: true; tickets: { include: { ticketType: true } } };
      }>
    >
  >
>;

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

  const logoBytes = await readFile(path.join(process.cwd(), 'public', 'brand', 'logo-black.png'));
  const logoImage = await pdf.embedPng(new Uint8Array(logoBytes));
  const logoAspect = logoImage.height / logoImage.width;

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

    const logoHeight = 26;
    const logoWidth = logoHeight / logoAspect;
    page.drawImage(logoImage, { x: margin, y: y - logoHeight, width: logoWidth, height: logoHeight });
    y -= logoHeight + 10;
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

const MM_TO_PT = 72 / 25.4;
/** Entrada física de taquilla: 105 × 70 mm, apaisada. */
export const TAQUILLA_TICKET_WIDTH_PT = 105 * MM_TO_PT;
export const TAQUILLA_TICKET_HEIGHT_PT = 70 * MM_TO_PT;

// Brand lima #C5E63A — mismo tono que bg-lima en la entrada digital.
const LIMA = rgb(197 / 255, 230 / 255, 58 / 255);
const INK = rgb(0.024, 0.024, 0.035);
const WHITE = rgb(1, 1, 1);

function pdfSafe(text: string): string {
  return text
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/€/g, 'EUR')
    .split('')
    .map((ch) => (ch.charCodeAt(0) <= 255 ? ch : '?'))
    .join('');
}

function truncateToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const safe = pdfSafe(text);
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
  let out = safe;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number, maxLines: number): string[] {
  const words = pdfSafe(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length === maxLines - 1) {
      lines.push(truncateToWidth([word, ...words.slice(i + 1)].join(' '), font, size, maxWidth));
      return lines;
    }
    current = font.widthOfTextAtSize(word, size) <= maxWidth ? word : truncateToWidth(word, font, size, maxWidth);
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function shortEventDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Madrid',
  }).formatToParts(new Date(date));
  const day = (parts.find((p) => p.type === 'day')?.value ?? '').padStart(2, '0');
  const month = (parts.find((p) => p.type === 'month')?.value ?? '').padStart(2, '0');
  return `${day}.${month}`;
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M ${x + radius} ${y}`,
    `H ${x + w - radius}`,
    `Q ${x + w} ${y} ${x + w} ${y + radius}`,
    `V ${y + h - radius}`,
    `Q ${x + w} ${y + h} ${x + w - radius} ${y + h}`,
    `H ${x + radius}`,
    `Q ${x} ${y + h} ${x} ${y + h - radius}`,
    `V ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    'Z',
  ].join(' ');
}

function drawTrackedText(
  page: PDFPage,
  text: string,
  opts: { x: number; y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb>; tracking?: number; opacity?: number }
) {
  const tracking = opts.tracking ?? 0.45;
  let cx = opts.x;
  for (const ch of pdfSafe(text)) {
    page.drawText(ch, {
      x: cx,
      y: opts.y,
      size: opts.size,
      font: opts.font,
      color: opts.color,
      opacity: opts.opacity,
    });
    cx += opts.font.widthOfTextAtSize(ch, opts.size) + tracking;
  }
}

function trackedWidth(text: string, font: PDFFont, size: number, tracking = 0.45): number {
  const safe = pdfSafe(text);
  if (!safe) return 0;
  let width = 0;
  for (const ch of safe) width += font.widthOfTextAtSize(ch, size) + tracking;
  return Math.max(0, width - tracking);
}

function wrapCode(text: string, font: PDFFont, size: number, maxWidth: number, maxLines: number): string[] {
  const safe = pdfSafe(text);
  if (!safe) return [];
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return [safe];
  const lines: string[] = [];
  let rest = safe;
  while (rest.length > 0 && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      lines.push(truncateToWidth(rest, font, size, maxWidth));
      break;
    }
    let cut = rest.length;
    while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) {
      cut--;
    }
    const hyphen = rest.lastIndexOf('-', cut - 1);
    if (hyphen >= 4) cut = hyphen + 1;
    if (cut < 1) cut = 1;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return lines;
}

function drawCenteredText(
  page: PDFPage,
  text: string,
  opts: { centerX: number; y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb>; opacity?: number }
) {
  const safe = pdfSafe(text);
  const width = opts.font.widthOfTextAtSize(safe, opts.size);
  page.drawText(safe, {
    x: opts.centerX - width / 2,
    y: opts.y,
    size: opts.size,
    font: opts.font,
    color: opts.color,
    opacity: opts.opacity,
  });
}

function drawDecorativeBarcode(page: PDFPage, x: number, y: number, width: number, height: number) {
  const pattern = [2, 2, 1, 3, 4, 2];
  let cx = x;
  let filled = true;
  while (cx < x + width) {
    for (const segment of pattern) {
      const barWidth = Math.min(segment, x + width - cx);
      if (barWidth <= 0) return;
      if (filled) {
        page.drawRectangle({ x: cx, y, width: barWidth, height, color: INK, opacity: 0.7 });
      }
      cx += segment;
      filled = !filled;
      if (cx >= x + width) return;
    }
  }
}

function drawLabeledValue(
  page: PDFPage,
  label: string,
  valueLines: string[],
  opts: { x: number; y: number; labelFont: PDFFont; valueFont: PDFFont; valueSize?: number }
): number {
  const valueSize = opts.valueSize ?? 8.5;
  page.drawText(label, {
    x: opts.x,
    y: opts.y,
    size: 5.5,
    font: opts.labelFont,
    color: INK,
    opacity: 0.55,
  });
  let y = opts.y - 10;
  for (const line of valueLines) {
    page.drawText(line, {
      x: opts.x,
      y,
      size: valueSize,
      font: opts.valueFont,
      color: INK,
    });
    y -= valueSize + 2;
  }
  return y;
}

/**
 * Entrada de taquilla a tamaño de papel 105 × 70 mm, apaisada.
 * Cuerpo: escaneo (QR + código completo). Talón: titular y tipo, sin repetir el código.
 */
export async function buildTicketsPdfForRoll(order: OrderForPdf): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdf.embedFont(StandardFonts.Courier);
  const fontMonoBold = await pdf.embedFont(StandardFonts.CourierBold);

  const eventDateShort = shortEventDate(order.event?.date);
  const logoBytes = await readFile(path.join(process.cwd(), 'public', 'brand', 'logo-black.png'));
  const logoImage = await pdf.embedPng(new Uint8Array(logoBytes));
  const logoAspect = logoImage.height / logoImage.width;

  const width = TAQUILLA_TICKET_WIDTH_PT;
  const height = TAQUILLA_TICKET_HEIGHT_PT;
  const stubWidth = 80;
  const stubX = width - stubWidth;
  const notch = 7;
  const pad = 11;
  const gap = 8;

  for (const ticket of order.tickets ?? []) {
    const page = pdf.addPage([width, height]);
    page.drawRectangle({ x: 0, y: 0, width, height, color: LIMA });
    page.drawSvgPath(
      `M ${stubX - notch} 0 L ${stubX} ${notch} L ${stubX + notch} 0 Z`,
      { color: WHITE, y: height }
    );
    page.drawSvgPath(
      `M ${stubX - notch} ${height} L ${stubX} ${height - notch} L ${stubX + notch} ${height} Z`,
      { color: WHITE, y: height }
    );

    page.drawLine({
      start: { x: stubX, y: notch + 5 },
      end: { x: stubX, y: height - notch - 5 },
      thickness: 0.65,
      color: INK,
      opacity: 0.22,
      dashArray: [2.4, 2],
    });

    const bodyLeft = pad;
    const bodyRight = stubX - 7;
    const bodyWidth = bodyRight - bodyLeft;
    let y = height - pad;

    const logoHeight = 22;
    const logoWidth = logoHeight / logoAspect;
    page.drawImage(logoImage, {
      x: bodyLeft,
      y: y - logoHeight,
      width: logoWidth,
      height: logoHeight,
    });

    const city = pdfSafe((order.event?.city ?? '').toUpperCase());
    if (city) {
      const citySize = 6.5;
      const cityMax = Math.max(24, bodyWidth - logoWidth - 10);
      const cityText = truncateToWidth(city, fontMono, citySize, cityMax);
      const cityW = trackedWidth(cityText, fontMono, citySize, 0.55);
      drawTrackedText(page, cityText, {
        x: bodyRight - cityW,
        y: y - logoHeight / 2 - citySize / 3,
        size: citySize,
        font: fontMono,
        color: INK,
        tracking: 0.55,
        opacity: 0.5,
      });
    }

    const contentTop = y - logoHeight - 7;
    const qrCodeValue = (ticket.qrCode ?? '').toUpperCase();
    const codeSize = 6;
    const textMin = 70;
    const qrBoxSize = Math.min(contentTop - pad - 16, bodyWidth - gap - textMin);
    const qrPad = 4.5;
    const qrSize = qrBoxSize - qrPad * 2;
    const qrBoxX = bodyLeft;
    const qrBoxY = contentTop - qrBoxSize;

    const qrShadowSvgY = height - (qrBoxY - 0.7) - qrBoxSize;
    const qrBoxSvgY = height - qrBoxY - qrBoxSize;
    page.drawSvgPath(roundedRectPath(qrBoxX + 0.7, qrShadowSvgY, qrBoxSize, qrBoxSize, 3.5), {
      color: rgb(0, 0, 0),
      opacity: 0.12,
      y: height,
    });
    page.drawSvgPath(roundedRectPath(qrBoxX, qrBoxSvgY, qrBoxSize, qrBoxSize, 3.5), {
      color: WHITE,
      y: height,
    });

    const qrDataUrl = await generateQRDataUrl(ticket.qrCode ?? '');
    const qrImage = await pdf.embedPng(dataUrlToBytes(qrDataUrl));
    page.drawImage(qrImage, {
      x: qrBoxX + qrPad,
      y: qrBoxY + qrPad,
      width: qrSize,
      height: qrSize,
    });

    const textX = qrBoxX + qrBoxSize + gap;
    const textW = bodyRight - textX;
    const titleSize = 10.5;
    const titleLines = wrapText((order.event?.name ?? 'Evento').toUpperCase(), fontBold, titleSize, textW, 3);
    let textY = contentTop - 2;
    for (const line of titleLines) {
      page.drawText(line, {
        x: textX,
        y: textY - titleSize,
        size: titleSize,
        font: fontBold,
        color: INK,
      });
      textY -= titleSize + 2;
    }
    textY -= 8;

    textY = drawLabeledValue(page, 'FECHA', [eventDateShort], {
      x: textX,
      y: textY,
      labelFont: fontBold,
      valueFont: fontMonoBold,
      valueSize: 9,
    });
    textY -= 6;
    drawLabeledValue(page, 'TIPO', wrapText((ticket.ticketType?.name ?? 'General').toUpperCase(), fontMonoBold, 9, textW, 2), {
      x: textX,
      y: textY,
      labelFont: fontBold,
      valueFont: fontMonoBold,
      valueSize: 9,
    });

    const codeLines = wrapCode(qrCodeValue, fontMonoBold, codeSize, bodyWidth, 2);
    let codeY = qrBoxY - 5;
    for (const line of codeLines) {
      codeY -= codeSize;
      drawCenteredText(page, line, {
        centerX: bodyLeft + bodyWidth / 2,
        y: codeY,
        size: codeSize,
        font: fontMonoBold,
        color: INK,
        opacity: 0.7,
      });
      codeY -= 1.5;
    }

    const stubLeft = stubX + 8;
    const stubInnerWidth = width - pad - stubLeft;
    const barcodeH = 10;
    let stubY = height - pad - 2;

    stubY = drawLabeledValue(
      page,
      'TITULAR',
      wrapText((ticket.holderName ?? '').toUpperCase(), fontBold, 9, stubInnerWidth, 3),
      {
        x: stubLeft,
        y: stubY,
        labelFont: fontBold,
        valueFont: fontBold,
        valueSize: 9,
      }
    );

    const titularBottom = stubY;
    const barcodeTop = pad + barcodeH + 14;
    const fechaBlockH = 22;
    const fechaY = (titularBottom + barcodeTop) / 2 + fechaBlockH / 2;
    drawLabeledValue(page, 'FECHA', [eventDateShort], {
      x: stubLeft,
      y: fechaY,
      labelFont: fontBold,
      valueFont: fontMonoBold,
      valueSize: 12,
    });

    drawDecorativeBarcode(page, stubLeft, pad, stubInnerWidth, barcodeH);
  }

  return pdf.save();
}
