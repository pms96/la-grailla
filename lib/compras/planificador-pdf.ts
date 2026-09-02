import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import type { Temporada } from '@prisma/client';
import type { FilaPlanificador } from '@/lib/compras/planificador-data';

const PAGE_SIZE: [number, number] = [841.89, 595.28]; // A4 apaisado
const MARGIN = 36;
const ROW_HEIGHT = 16;

type Columna = { header: string; width: number; align?: 'left' | 'right' };

const COLUMNAS: Columna[] = [
  { header: 'Categoría', width: 90 },
  { header: 'Artículo', width: 170 },
  { header: 'Proveedor elegido', width: 120 },
  { header: 'Precio ud. c/IVA', width: 80, align: 'right' },
  { header: 'Cantidad', width: 60, align: 'right' },
  { header: 'Coste estimado', width: 90, align: 'right' },
  { header: 'Observaciones', width: 150 },
];

function truncar(texto: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(texto, size) <= maxWidth) return texto;
  let out = texto;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

export async function buildPlanificadorPdf(
  temporada: Temporada,
  temporadaAnterior: Temporada | null,
  filas: FilaPlanificador[]
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const morado = rgb(0.24, 0.18, 0.84);
  const gris = rgb(0.4, 0.4, 0.4);
  const negro = rgb(0.1, 0.1, 0.1);

  // Página inicial provisional (TS exige que `page` esté asignada antes de las
  // funciones que la usan); se descarta en cuanto newPage() crea la primera real.
  let page: PDFPage = pdf.addPage(PAGE_SIZE);
  let y = 0;
  const tableWidth = COLUMNAS.reduce((sum, c) => sum + c.width, 0);

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
    const { width, height } = page.getSize();
    y = height - MARGIN;
    if (withTitle) {
      page.drawText('La Grailla — Planificador de compras', { x: MARGIN, y, size: 16, font: fontBold, color: morado });
      y -= 22;
      page.drawText(`Temporada: ${temporada.nombre} (${temporada.anio})`, { x: MARGIN, y, size: 10, font, color: negro });
      y -= 14;
      if (temporadaAnterior) {
        page.drawText(`Consumo de referencia: ${temporadaAnterior.nombre}`, { x: MARGIN, y, size: 9, font, color: gris });
        y -= 14;
      }
      page.drawText(`Generado el ${new Date().toLocaleDateString('es-ES')}`, { x: MARGIN, y, size: 8, font, color: gris });
      y -= 18;
    }
    drawHeaderRow();
    void width;
  };

  newPage(true);
  pdf.removePage(0);

  filas.forEach((f) => {
    if (y < MARGIN + ROW_HEIGHT) {
      newPage(false);
    }
    const precioElegido = f.precios.find((p) => p.proveedorId === f.proveedorElegidoId);
    const proveedorNombre = precioElegido?.proveedorNombre ?? '—';
    const valores = [
      f.categoria,
      f.nombre,
      proveedorNombre,
      precioElegido ? `${precioElegido.precioConIva.toFixed(2)}€` : '—',
      String(f.cantidadPlanificada),
      `${f.costeTotalEstimado.toFixed(2)}€`,
      f.observaciones || '',
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

  if (y < MARGIN + ROW_HEIGHT) newPage(false);
  const totalUnidades = filas.reduce((sum, f) => sum + f.cantidadPlanificada, 0);
  const totalCoste = filas.reduce((sum, f) => sum + f.costeTotalEstimado, 0);
  y -= 6;
  page.drawText(
    `Totales — ${totalUnidades} unidades · ${totalCoste.toFixed(2)}€ estimados`,
    { x: MARGIN, y, size: 10, font: fontBold, color: morado }
  );

  return pdf.save();
}
