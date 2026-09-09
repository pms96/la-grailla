import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { resolveMinorAuthorizationText } from '@/lib/minor-authorization-text';

export type EventForMinorAuthorizationPdf = {
  name: string;
  venue: string | null;
  city: string | null;
  date: Date | string;
  minorAuthorizationText?: string | null;
};

// Duplicado a propósito (no importado de lib/ticket-pdf.ts): son funciones
// privadas de ese módulo y este PDF necesita una variante que respete
// párrafos (\n), que ticket-pdf.ts no soporta.
function pdfSafe(text: string): string {
  return text
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
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

/** Como wrapText, pero respeta saltos de párrafo (\n) — '' en el resultado marca un salto de párrafo. */
function wrapParagraphs(text: string, font: PDFFont, size: number, maxWidth: number, maxTotalLines: number): string[] {
  const paragraphs = pdfSafe(text)
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    if (out.length >= maxTotalLines) break;
    const remaining = maxTotalLines - out.length;
    out.push(...wrapText(paragraphs[i], font, size, maxWidth, remaining));
    if (i < paragraphs.length - 1 && out.length < maxTotalLines) out.push('');
  }
  return out;
}

const INK = rgb(0.1, 0.1, 0.1);
const LABEL_COLOR = rgb(0.4, 0.4, 0.4);
const LINE_COLOR = rgb(0.6, 0.6, 0.6);

/** Dibuja un campo "Etiqueta" + línea horizontal en blanco para rellenar a mano. */
function drawBlankField(page: PDFPage, label: string, opts: { x: number; y: number; width: number; font: PDFFont; labelSize?: number }): number {
  const labelSize = opts.labelSize ?? 8.5;
  page.drawText(pdfSafe(label), { x: opts.x, y: opts.y, size: labelSize, font: opts.font, color: LABEL_COLOR });
  const lineY = opts.y - 12;
  page.drawLine({
    start: { x: opts.x, y: lineY },
    end: { x: opts.x + opts.width, y: lineY },
    thickness: 0.75,
    color: LINE_COLOR,
  });
  return opts.y - 26;
}

/**
 * Genera el PDF de autorización de menores (16-17 años) para un evento: una
 * página A4 con los bloques de datos del menor y del tutor (líneas en blanco
 * para rellenar a mano) y el texto legal editable del evento, para imprimir,
 * firmar y entregar en taquilla. Se genera al vuelo en cada descarga — no se
 * cachea ni se sube a blob, así una edición del texto por el admin se
 * refleja al instante.
 */
export async function buildMinorAuthorizationPdf(event: EventForMinorAuthorizationPdf): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page = pdf.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();
  const margin = 48;
  const contentWidth = width - margin * 2;
  let y = height - margin;

  const draw = (text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; gap?: number } = {}) => {
    const size = opts.size ?? 11;
    page.drawText(pdfSafe(text), {
      x: margin,
      y,
      size,
      font: opts.bold ? fontBold : font,
      color: opts.color ?? INK,
      maxWidth: contentWidth,
    });
    y -= size + (opts.gap ?? 6);
  };

  const eventDate = event.date
    ? new Date(event.date).toLocaleDateString('es-ES', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'Europe/Madrid',
      })
    : '';

  // Cabecera
  draw('La Grailla', { size: 22, bold: true, color: rgb(0.55, 0.2, 0.85) });
  draw('Autorizacion de menores', { size: 11, color: rgb(0.4, 0.4, 0.4) });
  y -= 10;

  // Datos del evento
  draw(event.name || 'Evento', { size: 16, bold: true });
  draw(`Fecha: ${eventDate}`, { size: 11 });
  draw(`Lugar: ${event.venue ?? ''} - ${event.city ?? ''}`, { size: 11 });
  y -= 12;

  // Aviso fijo: a quién va dirigida
  draw('Esta autorizacion esta dirigida a:', { size: 10, bold: true, gap: 8 });
  for (const line of wrapText(
    'Los menores con edad inferior a 16 anos deberan acceder acompanados en todo momento por su padre/madre/tutor, con esta autorizacion rellena.',
    font,
    9,
    contentWidth,
    3
  )) {
    draw(line, { size: 9, gap: 3 });
  }
  y -= 3;
  for (const line of wrapText(
    'Los menores de 16 y 17 anos deberan presentar esta autorizacion, rellena y firmada, en taquilla de entrada.',
    font,
    9,
    contentWidth,
    3
  )) {
    draw(line, { size: 9, gap: 3 });
  }
  y -= 14;

  // Bloque: datos del menor
  draw('Datos del menor asistente al evento', { size: 12, bold: true, gap: 12 });
  for (const label of ['Nombre y Apellidos', 'DNI', 'Fecha de nacimiento', 'Localidad', 'Telefono', 'Email']) {
    y = drawBlankField(page, label, { x: margin, y, width: 360, font });
  }
  y -= 8;

  // Bloque: datos del padre/madre/tutor
  draw('Datos del padre/madre/tutor que autoriza', { size: 12, bold: true, gap: 12 });
  for (const label of ['Nombre y Apellidos', 'DNI', 'Telefono']) {
    y = drawBlankField(page, label, { x: margin, y, width: 360, font });
  }
  y -= 10;

  // Texto legal editable por evento
  const legalLines = wrapParagraphs(resolveMinorAuthorizationText(event), font, 9, contentWidth, 40);
  for (const line of legalLines) {
    if (line === '') {
      y -= 6;
      continue;
    }
    draw(line, { size: 9, gap: 3 });
  }
  y -= 16;

  // Pie fijo: entrega, fecha/lugar y firma
  draw('ENTREGAR EN TAQUILLA', { size: 12, bold: true, gap: 14 });
  draw('En ________________________________, a _______ de _____________________ de 20____.', { size: 10, gap: 22 });
  draw('Fdo. (padre/madre/tutor):', { size: 10, gap: 10 });
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + 260, y },
    thickness: 0.75,
    color: LINE_COLOR,
  });

  return pdf.save();
}
