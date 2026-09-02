import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import type { Proveedor } from '@prisma/client';

const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4 vertical
const MARGIN = 48;
const ROW_HEIGHT = 18;

type Columna = { header: string; width: number };

const COLUMNAS: Columna[] = [
  { header: 'Nombre', width: 130 },
  { header: 'Contacto', width: 100 },
  { header: 'Teléfono', width: 80 },
  { header: 'Email', width: 130 },
  { header: 'Estado', width: 59 },
];

function truncar(texto: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(texto, size) <= maxWidth) return texto;
  let out = texto;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

export async function buildProveedoresPdf(proveedores: Proveedor[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const morado = rgb(0.24, 0.18, 0.84);
  const gris = rgb(0.4, 0.4, 0.4);
  const negro = rgb(0.1, 0.1, 0.1);
  const tableWidth = COLUMNAS.reduce((sum, c) => sum + c.width, 0);

  let page: PDFPage = pdf.addPage(PAGE_SIZE);
  let y = 0;

  const drawHeaderRow = () => {
    let x = MARGIN;
    page.drawRectangle({ x: MARGIN, y: y - 4, width: tableWidth, height: ROW_HEIGHT, color: morado });
    COLUMNAS.forEach((col) => {
      page.drawText(col.header, { x: x + 4, y, size: 9, font: fontBold, color: rgb(1, 1, 1) });
      x += col.width;
    });
    y -= ROW_HEIGHT;
  };

  const newPage = (withTitle: boolean) => {
    page = pdf.addPage(PAGE_SIZE);
    y = page.getSize().height - MARGIN;
    if (withTitle) {
      page.drawText('La Grailla — Proveedores', { x: MARGIN, y, size: 16, font: fontBold, color: morado });
      y -= 22;
      page.drawText(`Generado el ${new Date().toLocaleDateString('es-ES')}`, { x: MARGIN, y, size: 9, font, color: gris });
      y -= 18;
    }
    drawHeaderRow();
  };

  newPage(true);
  pdf.removePage(0);

  proveedores.forEach((p) => {
    if (y < MARGIN + ROW_HEIGHT) newPage(false);
    const valores = [p.nombre, p.contacto ?? '—', p.telefono ?? '—', p.email ?? '—', p.activo ? 'Activo' : 'Inactivo'];
    let x = MARGIN;
    COLUMNAS.forEach((col, i) => {
      const texto = truncar(valores[i], font, 9, col.width - 8);
      page.drawText(texto, { x: x + 4, y, size: 9, font, color: negro });
      x += col.width;
    });
    y -= ROW_HEIGHT;
    page.drawLine({
      start: { x: MARGIN, y: y + ROW_HEIGHT - 4 },
      end: { x: MARGIN + tableWidth, y: y + ROW_HEIGHT - 4 },
      thickness: 0.5,
      color: rgb(0.88, 0.88, 0.88),
    });
  });

  return pdf.save();
}
