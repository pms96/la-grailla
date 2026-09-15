import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import { precioFinalUnidad, precioTrasDescuento } from '@/lib/compras/calculadora';
import { PEDIDO_STATUS_LABEL } from '@/lib/compras/constantes';
import type { PedidosParaExport, PedidoParaExport, PedidosExportOptions } from '@/lib/compras/pedidos-data';

const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4 vertical
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_SIZE[0] - MARGIN * 2;
const ROW_HEIGHT = 18;

type Columna = { key: string; header: string; base: number; align?: 'left' | 'right'; width: number };

// Artículo y Cantidad son la base fija del documento; el resto de columnas solo aparece si su
// check está activo — nada se muestra "porque sí", cada columna es una decisión explícita del admin.
function buildColumnas(opts: Required<PedidosExportOptions>): Columna[] {
  const cols: Omit<Columna, 'width'>[] = [{ key: 'articulo', header: 'Artículo', base: 150 }];
  if (opts.incluirFormato) cols.push({ key: 'formato', header: 'Formato', base: 90 });
  if (opts.incluirFormatoProveedor) cols.push({ key: 'formatoProveedor', header: 'Fmt. proveedor', base: 90 });
  cols.push({ key: 'cantidad', header: 'Cantidad', base: 55, align: 'right' });
  if (opts.incluirPrecioSinIva) cols.push({ key: 'precioUdSinIva', header: 'Ud. s/IVA', base: 62, align: 'right' });
  if (opts.incluirPrecioConIva) cols.push({ key: 'precioUd', header: 'Ud. c/IVA', base: 62, align: 'right' });
  if (opts.incluirIvaDescuento) {
    cols.push({ key: 'ivaPercent', header: '% IVA', base: 42, align: 'right' });
    cols.push({ key: 'descuentoPercent', header: '% Dto.', base: 42, align: 'right' });
  }
  if (opts.incluirSubtotalSinIva) cols.push({ key: 'subtotalSinIva', header: 'Subt. s/IVA', base: 66, align: 'right' });
  if (opts.incluirSubtotalConIva) cols.push({ key: 'subtotal', header: 'Subt. c/IVA', base: 66, align: 'right' });

  // Los anchos "base" están pensados para una tabla cómoda de 3-5 columnas. Si el admin activa
  // más checks de los que caben en el ancho de una A4, se reduce todo proporcionalmente en vez
  // de desbordar la página — el texto que aun así no quepa se trunca con "…" al dibujar la fila.
  const totalBase = cols.reduce((sum, c) => sum + c.base, 0);
  const escala = totalBase > CONTENT_WIDTH ? CONTENT_WIDTH / totalBase : 1;
  return cols.map((c) => ({ ...c, width: Math.floor(c.base * escala) }));
}

function tamanoFuente(nColumnas: number): number {
  if (nColumnas > 9) return 6.5;
  if (nColumnas > 7) return 7.5;
  return 9;
}

function truncar(texto: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(texto, size) <= maxWidth) return texto;
  let out = texto;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

export async function buildPedidosPdf(data: PedidosParaExport, opts: PedidosExportOptions = {}): Promise<Uint8Array> {
  const options: Required<PedidosExportOptions> = {
    incluirFormato: opts.incluirFormato ?? false,
    incluirFormatoProveedor: opts.incluirFormatoProveedor ?? false,
    incluirPrecioSinIva: opts.incluirPrecioSinIva ?? false,
    incluirPrecioConIva: opts.incluirPrecioConIva ?? false,
    incluirIvaDescuento: opts.incluirIvaDescuento ?? false,
    incluirSubtotalSinIva: opts.incluirSubtotalSinIva ?? false,
    incluirSubtotalConIva: opts.incluirSubtotalConIva ?? false,
  };
  // El "Total pedido" resume la columna de subtotal correspondiente — sin esa columna no hay
  // nada que sumar, así que su presencia también depende únicamente del check del subtotal.
  const mostrarTotalConIva = options.incluirSubtotalConIva;
  const mostrarTotalSinIva = options.incluirSubtotalSinIva;

  const { temporada, pedidos, formatoProveedorPorClave } = data;
  const COLUMNAS = buildColumnas(options);
  const fontSize = tamanoFuente(COLUMNAS.length);

  const formatoProveedorLinea = (proveedorId: string, l: PedidoParaExport['lineas'][number]) =>
    formatoProveedorPorClave.get(`${l.articuloId}_${proveedorId}`) ?? '—';

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
      page.drawText(col.header, { x: x + 4, y, size: fontSize, font: fontBold, color: rgb(1, 1, 1) });
      x += col.width;
    });
    y -= ROW_HEIGHT;
  };

  const newPage = () => {
    page = pdf.addPage(PAGE_SIZE);
    y = page.getSize().height - MARGIN;
  };

  const totalConIvaPedido = (p: PedidoParaExport) =>
    p.lineas.reduce((sum, l) => sum + precioFinalUnidad(l.precioSinIva, l.descuentoPercent, l.ivaPercent) * l.cantidad, 0);
  const totalSinIvaPedido = (p: PedidoParaExport) =>
    p.lineas.reduce((sum, l) => sum + precioTrasDescuento(l.precioSinIva, l.descuentoPercent) * l.cantidad, 0);

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
      const precioUdSinIva = precioTrasDescuento(l.precioSinIva, l.descuentoPercent);
      const precioUd = precioFinalUnidad(l.precioSinIva, l.descuentoPercent, l.ivaPercent);
      const valoresPorClave: Record<string, string> = {
        articulo: l.articulo.nombre,
        formato: l.articulo.formato,
        formatoProveedor: formatoProveedorLinea(pedido.proveedorId, l),
        cantidad: String(l.cantidad),
        precioUdSinIva: `${precioUdSinIva.toFixed(2)}€`,
        precioUd: `${precioUd.toFixed(2)}€`,
        ivaPercent: `${l.ivaPercent}%`,
        descuentoPercent: `${l.descuentoPercent}%`,
        subtotalSinIva: `${(precioUdSinIva * l.cantidad).toFixed(2)}€`,
        subtotal: `${(precioUd * l.cantidad).toFixed(2)}€`,
      };
      let x = MARGIN;
      COLUMNAS.forEach((col) => {
        const texto = truncar(valoresPorClave[col.key] ?? '', font, fontSize, col.width - 8);
        const textWidth = col.align === 'right' ? font.widthOfTextAtSize(texto, fontSize) : 0;
        page.drawText(texto, {
          x: col.align === 'right' ? x + col.width - 4 - textWidth : x + 4,
          y,
          size: fontSize,
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

    if (mostrarTotalSinIva || mostrarTotalConIva) {
      if (y < MARGIN + ROW_HEIGHT * 2) newPage();
      y -= 8;
      if (mostrarTotalSinIva) {
        page.drawText(`Total pedido (sin IVA): ${totalSinIvaPedido(pedido).toFixed(2)}€`, { x: MARGIN, y, size: 10, font, color: gris });
        y -= 16;
      }
      if (mostrarTotalConIva) {
        page.drawText(`Total pedido: ${totalConIvaPedido(pedido).toFixed(2)}€ (c/IVA)`, { x: MARGIN, y, size: 12, font: fontBold, color: morado });
      }
    }
  });

  return pdf.save();
}
