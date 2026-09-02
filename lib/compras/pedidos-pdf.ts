import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import { precioConIva } from '@/lib/compras/calculadora';
import { PEDIDO_STATUS_LABEL } from '@/lib/compras/constantes';
import type { PedidosParaExport, PedidoParaExport } from '@/lib/compras/pedidos-data';

const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4 vertical
const MARGIN = 48;
const ROW_HEIGHT = 18;

type Columna = { header: string; width: number; align?: 'left' | 'right' };

const COLUMNAS: Columna[] = [
  { header: 'Artículo', width: 210 },
  { header: 'Formato', width: 110 },
  { header: 'Cantidad', width: 60, align: 'right' },
  { header: 'Precio ud. c/IVA', width: 75, align: 'right' },
  { header: 'Subtotal', width: 75, align: 'right' },
];

function truncar(texto: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(texto, size) <= maxWidth) return texto;
  let out = texto;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

export async function buildPedidosPdf(data: PedidosParaExport): Promise<Uint8Array> {
  const { temporada, pedidos } = data;
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

  const newPage = () => {
    page = pdf.addPage(PAGE_SIZE);
    y = page.getSize().height - MARGIN;
  };

  const totalPedido = (p: PedidoParaExport) => p.lineas.reduce((sum, l) => sum + precioConIva(l.precioSinIva, l.ivaPercent) * l.cantidad, 0);

  pedidos.forEach((pedido, index) => {
    if (index === 0) {
      pdf.removePage(0);
      newPage();
    } else {
      newPage();
    }

    page.drawText('La Grailla — Pedido a proveedor', { x: MARGIN, y, size: 12, font, color: gris });
    y -= 22;
    page.drawText(pedido.proveedor.nombre, { x: MARGIN, y, size: 20, font: fontBold, color: morado });
    y -= 24;
    page.drawText(`${temporada.nombre} · Estado: ${PEDIDO_STATUS_LABEL[pedido.status] ?? pedido.status}`, { x: MARGIN, y, size: 10, font, color: negro });
    y -= 14;
    const contacto = [pedido.proveedor.contacto, pedido.proveedor.telefono, pedido.proveedor.email].filter(Boolean).join(' · ');
    if (contacto) {
      page.drawText(contacto, { x: MARGIN, y, size: 9, font, color: gris });
      y -= 14;
    }
    page.drawText(`Fecha: ${new Date(pedido.fechaPedido).toLocaleDateString('es-ES')}`, { x: MARGIN, y, size: 9, font, color: gris });
    y -= 20;

    drawHeaderRow();

    pedido.lineas.forEach((l) => {
      if (y < MARGIN + ROW_HEIGHT * 2) {
        newPage();
        drawHeaderRow();
      }
      const precioUd = precioConIva(l.precioSinIva, l.ivaPercent);
      const valores = [
        l.articulo.nombre,
        l.articulo.formato,
        String(l.cantidad),
        `${precioUd.toFixed(2)}€`,
        `${(precioUd * l.cantidad).toFixed(2)}€`,
      ];
      let x = MARGIN;
      COLUMNAS.forEach((col, i) => {
        const texto = truncar(valores[i], font, 9, col.width - 8);
        const textWidth = col.align === 'right' ? font.widthOfTextAtSize(texto, 9) : 0;
        page.drawText(texto, {
          x: col.align === 'right' ? x + col.width - 4 - textWidth : x + 4,
          y,
          size: 9,
          font,
          color: negro,
        });
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

    if (y < MARGIN + ROW_HEIGHT) newPage();
    y -= 8;
    page.drawText(`Total pedido: ${totalPedido(pedido).toFixed(2)}€ (c/IVA)`, { x: MARGIN, y, size: 12, font: fontBold, color: morado });
  });

  return pdf.save();
}
