import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import type { Articulo, PrecioArticulo, Proveedor } from '@prisma/client';
import { precioFinalUnidad } from '@/lib/compras/calculadora';

type ArticuloConPrecios = Articulo & { precios: (PrecioArticulo & { proveedor: Proveedor })[] };

const PAGE_SIZE: [number, number] = [841.89, 595.28]; // A4 apaisado
const MARGIN = 36;
const ROW_HEIGHT = 16;

type Columna = { header: string; width: number; align?: 'left' | 'right' };

const COLUMNAS: Columna[] = [
  { header: 'Categoría', width: 80 },
  { header: 'Artículo', width: 175 },
  { header: 'Formato', width: 100 },
  { header: 'Proveedor más barato', width: 125 },
  { header: 'Precio ud. c/IVA', width: 85, align: 'right' },
  { header: 'Dto.', width: 45, align: 'right' },
  { header: 'Ud. mín.', width: 50, align: 'right' },
  { header: 'Estado', width: 70 },
];

function truncar(texto: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(texto, size) <= maxWidth) return texto;
  let out = texto;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

export async function buildArticulosPdf(articulos: ArticuloConPrecios[]): Promise<Uint8Array> {
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
      page.drawText(col.header, { x: x + 4, y, size: 8, font: fontBold, color: rgb(1, 1, 1) });
      x += col.width;
    });
    y -= ROW_HEIGHT;
  };

  const newPage = (withTitle: boolean) => {
    page = pdf.addPage(PAGE_SIZE);
    y = page.getSize().height - MARGIN;
    if (withTitle) {
      page.drawText('La Grailla — Catálogo de artículos', { x: MARGIN, y, size: 16, font: fontBold, color: morado });
      y -= 22;
      page.drawText(`Generado el ${new Date().toLocaleDateString('es-ES')}`, { x: MARGIN, y, size: 9, font, color: gris });
      y -= 18;
    }
    drawHeaderRow();
  };

  newPage(true);
  pdf.removePage(0);

  articulos.forEach((a) => {
    if (y < MARGIN + ROW_HEIGHT) newPage(false);
    const mejor = a.precios.reduce<(typeof a.precios)[number] | null>((min, p) => {
      const c = precioFinalUnidad(p.precioSinIva, p.descuentoPercent, a.ivaPercent);
      const cMin = min ? precioFinalUnidad(min.precioSinIva, min.descuentoPercent, a.ivaPercent) : Infinity;
      return c < cMin ? p : min;
    }, null);
    const valores = [
      a.categoria,
      a.nombre,
      a.formato,
      mejor?.proveedor.nombre ?? '—',
      mejor ? `${precioFinalUnidad(mejor.precioSinIva, mejor.descuentoPercent, a.ivaPercent).toFixed(2)}€` : '—',
      mejor && mejor.descuentoPercent > 0 ? `${mejor.descuentoPercent}%` : '—',
      mejor ? String(mejor.unidadMinPedido) : '—',
      a.activo ? 'Activo' : 'Inactivo',
    ];
    let x = MARGIN;
    COLUMNAS.forEach((col, i) => {
      const texto = truncar(valores[i], font, 8, col.width - 8);
      const textWidth = col.align === 'right' ? font.widthOfTextAtSize(texto, 8) : 0;
      page.drawText(texto, {
        x: col.align === 'right' ? x + col.width - 4 - textWidth : x + 4,
        y,
        size: 8,
        font,
        color: negro,
      });
      x += col.width;
    });
    y -= ROW_HEIGHT;
    page.drawLine({
      start: { x: MARGIN, y: y + ROW_HEIGHT - 3 },
      end: { x: MARGIN + tableWidth, y: y + ROW_HEIGHT - 3 },
      thickness: 0.5,
      color: rgb(0.88, 0.88, 0.88),
    });
  });

  return pdf.save();
}
