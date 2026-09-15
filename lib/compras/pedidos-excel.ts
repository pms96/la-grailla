import ExcelJS from 'exceljs';
import { precioFinalUnidad, precioTrasDescuento } from '@/lib/compras/calculadora';
import { PEDIDO_STATUS_LABEL } from '@/lib/compras/constantes';
import type { PedidosParaExport, PedidosExportOptions } from '@/lib/compras/pedidos-data';

const MORADO = 'FF3D2FD5';
const GRIS_CLARO = 'FFF2F2F7';
const MONEY_FMT = '#,##0.00 €';
const PERCENT_FMT = '0.##"%"';

type LineaConArticulo = PedidosParaExport['pedidos'][number]['lineas'][number];
type Columna = { key: string; header: string; width: number };

function nombreHoja(nombre: string, usados: Set<string>): string {
  let base = nombre.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Proveedor';
  let candidato = base;
  let n = 2;
  while (usados.has(candidato.toLowerCase())) {
    candidato = `${base.slice(0, 28)} ${n}`;
    n += 1;
  }
  usados.add(candidato.toLowerCase());
  return candidato;
}

function buildColumnas(opts: Required<PedidosExportOptions>): Columna[] {
  const cols: Columna[] = [
    { key: 'articulo', header: 'Artículo', width: 30 },
    { key: 'formato', header: 'Formato', width: 18 },
  ];
  if (opts.incluirFormatoProveedor) cols.push({ key: 'formatoProveedor', header: 'Formato proveedor', width: 20 });
  cols.push({ key: 'cantidad', header: 'Cantidad', width: 12 });
  if (opts.incluirPrecios) {
    if (opts.incluirPrecioSinIva) cols.push({ key: 'precioUdSinIva', header: 'Precio ud. s/IVA (€)', width: 18 });
    cols.push({ key: 'precioUd', header: 'Precio ud. c/IVA (€)', width: 18 });
    if (opts.incluirIvaDescuento) {
      cols.push({ key: 'ivaPercent', header: '% IVA', width: 10 });
      cols.push({ key: 'descuentoPercent', header: '% Descuento', width: 12 });
    }
    if (opts.incluirSubtotalSinIva) cols.push({ key: 'subtotalSinIva', header: 'Subtotal s/IVA (€)', width: 18 });
    cols.push({ key: 'subtotal', header: 'Subtotal c/IVA (€)', width: 18 });
  }
  return cols;
}

export async function buildPedidosExcel(data: PedidosParaExport, opts: PedidosExportOptions = {}): Promise<Buffer> {
  const incluirPrecios = opts.incluirPrecios ?? true;
  const options: Required<PedidosExportOptions> = {
    incluirPrecios,
    // Los desgloses de precio no tienen sentido si no se incluyen precios en absoluto.
    incluirPrecioSinIva: incluirPrecios && (opts.incluirPrecioSinIva ?? false),
    incluirSubtotalSinIva: incluirPrecios && (opts.incluirSubtotalSinIva ?? false),
    incluirIvaDescuento: incluirPrecios && (opts.incluirIvaDescuento ?? false),
    incluirFormatoProveedor: opts.incluirFormatoProveedor ?? false,
  };
  const { temporada, pedidos, formatoProveedorPorClave } = data;
  const columnas = buildColumnas(options);

  const formatoProveedorLinea = (proveedorId: string, l: LineaConArticulo) =>
    formatoProveedorPorClave.get(`${l.articuloId}_${proveedorId}`) ?? '—';

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'La Grailla';
  workbook.created = new Date();

  const totalConIvaPedido = (p: PedidosParaExport['pedidos'][number]) =>
    p.lineas.reduce((sum, l) => sum + precioFinalUnidad(l.precioSinIva, l.descuentoPercent, l.ivaPercent) * l.cantidad, 0);
  const totalSinIvaPedido = (p: PedidosParaExport['pedidos'][number]) =>
    p.lineas.reduce((sum, l) => sum + precioTrasDescuento(l.precioSinIva, l.descuentoPercent) * l.cantidad, 0);

  const resumen = workbook.addWorksheet('Resumen');
  resumen.columns = [
    { header: 'Proveedor', key: 'proveedor', width: 26 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Nº artículos', key: 'nArticulos', width: 14 },
    ...(incluirPrecios ? [{ header: 'Total estimado (€ c/IVA)', key: 'total', width: 22 }] : []),
  ];
  const resumenHeader = resumen.getRow(1);
  resumenHeader.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MORADO } };
  });
  pedidos.forEach((p) => {
    resumen.addRow({
      proveedor: p.proveedor.nombre,
      estado: PEDIDO_STATUS_LABEL[p.status] ?? p.status,
      nArticulos: p.lineas.length,
      ...(incluirPrecios ? { total: Math.round(totalConIvaPedido(p) * 100) / 100 } : {}),
    });
  });
  if (incluirPrecios) {
    resumen.getColumn('total').numFmt = MONEY_FMT;
    const totalGeneralRow = resumen.addRow({
      proveedor: 'TOTAL TEMPORADA',
      total: Math.round(pedidos.reduce((sum, p) => sum + totalConIvaPedido(p), 0) * 100) / 100,
    });
    totalGeneralRow.font = { bold: true };
    totalGeneralRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_CLARO } };
    });
  }

  const nombresUsados = new Set<string>(['resumen']);

  pedidos.forEach((pedido) => {
    const sheet = workbook.addWorksheet(nombreHoja(pedido.proveedor.nombre, nombresUsados));

    sheet.mergeCells(1, 1, 1, Math.max(columnas.length, 1));
    sheet.getCell('A1').value = `Pedido a ${pedido.proveedor.nombre}`;
    sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: MORADO } };

    const infoContacto = [pedido.proveedor.contacto, pedido.proveedor.telefono, pedido.proveedor.email]
      .filter(Boolean)
      .join(' · ');
    sheet.getCell('A2').value = `${temporada.nombre} — Estado: ${PEDIDO_STATUS_LABEL[pedido.status] ?? pedido.status}`;
    if (infoContacto) sheet.getCell('A3').value = infoContacto;

    sheet.addRow([]);
    const headerRowNumber = infoContacto ? 5 : 4;
    const headerRow = sheet.getRow(headerRowNumber);
    headerRow.values = columnas.map((c) => c.header);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MORADO } };
    });
    sheet.columns = columnas.map((c) => ({ key: c.key, width: c.width }));

    const tieneColumna = (key: string) => columnas.some((c) => c.key === key);

    pedido.lineas.forEach((l) => {
      const precioUdSinIva = precioTrasDescuento(l.precioSinIva, l.descuentoPercent);
      const precioUd = precioFinalUnidad(l.precioSinIva, l.descuentoPercent, l.ivaPercent);
      const row = sheet.addRow({
        articulo: l.articulo.nombre,
        formato: l.articulo.formato,
        formatoProveedor: formatoProveedorLinea(pedido.proveedorId, l),
        cantidad: l.cantidad,
        precioUdSinIva,
        precioUd,
        ivaPercent: l.ivaPercent,
        descuentoPercent: l.descuentoPercent,
        subtotalSinIva: Math.round(precioUdSinIva * l.cantidad * 100) / 100,
        subtotal: Math.round(precioUd * l.cantidad * 100) / 100,
      });
      if (tieneColumna('precioUdSinIva')) row.getCell('precioUdSinIva').numFmt = MONEY_FMT;
      if (tieneColumna('precioUd')) row.getCell('precioUd').numFmt = MONEY_FMT;
      if (tieneColumna('ivaPercent')) row.getCell('ivaPercent').numFmt = PERCENT_FMT;
      if (tieneColumna('descuentoPercent')) row.getCell('descuentoPercent').numFmt = PERCENT_FMT;
      if (tieneColumna('subtotalSinIva')) row.getCell('subtotalSinIva').numFmt = MONEY_FMT;
      if (tieneColumna('subtotal')) row.getCell('subtotal').numFmt = MONEY_FMT;
    });

    if (incluirPrecios) {
      const totalRow = sheet.addRow({
        articulo: 'TOTAL',
        ...(tieneColumna('subtotalSinIva') ? { subtotalSinIva: Math.round(totalSinIvaPedido(pedido) * 100) / 100 } : {}),
        subtotal: Math.round(totalConIvaPedido(pedido) * 100) / 100,
      });
      totalRow.font = { bold: true };
      if (tieneColumna('subtotalSinIva')) totalRow.getCell('subtotalSinIva').numFmt = MONEY_FMT;
      totalRow.getCell('subtotal').numFmt = MONEY_FMT;
      totalRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_CLARO } };
      });
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
