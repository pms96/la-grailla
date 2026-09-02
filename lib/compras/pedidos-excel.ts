import ExcelJS from 'exceljs';
import { precioConIva } from '@/lib/compras/calculadora';
import { PEDIDO_STATUS_LABEL } from '@/lib/compras/constantes';
import type { PedidosParaExport } from '@/lib/compras/pedidos-data';

const MORADO = 'FF3D2FD5';
const GRIS_CLARO = 'FFF2F2F7';
const MONEY_FMT = '#,##0.00 €';

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

export async function buildPedidosExcel(data: PedidosParaExport): Promise<Buffer> {
  const { temporada, pedidos } = data;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'La Grailla';
  workbook.created = new Date();

  const totalPorPedido = (p: PedidosParaExport['pedidos'][number]) =>
    p.lineas.reduce((sum, l) => sum + precioConIva(l.precioSinIva, l.ivaPercent) * l.cantidad, 0);

  const resumen = workbook.addWorksheet('Resumen');
  resumen.columns = [
    { header: 'Proveedor', key: 'proveedor', width: 26 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Nº artículos', key: 'nArticulos', width: 14 },
    { header: 'Total estimado (€ c/IVA)', key: 'total', width: 22 },
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
      total: Math.round(totalPorPedido(p) * 100) / 100,
    });
  });
  resumen.getColumn('total').numFmt = MONEY_FMT;
  const totalGeneralRow = resumen.addRow({
    proveedor: 'TOTAL TEMPORADA',
    total: Math.round(pedidos.reduce((sum, p) => sum + totalPorPedido(p), 0) * 100) / 100,
  });
  totalGeneralRow.font = { bold: true };
  totalGeneralRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_CLARO } };
  });

  const nombresUsados = new Set<string>(['resumen']);

  pedidos.forEach((pedido) => {
    const sheet = workbook.addWorksheet(nombreHoja(pedido.proveedor.nombre, nombresUsados));

    sheet.mergeCells('A1:E1');
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
    headerRow.values = ['Artículo', 'Formato', 'Cantidad', 'Precio ud. (€ c/IVA)', 'Subtotal (€)'];
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MORADO } };
    });
    sheet.columns = [
      { key: 'articulo', width: 30 },
      { key: 'formato', width: 18 },
      { key: 'cantidad', width: 12 },
      { key: 'precioUd', width: 18 },
      { key: 'subtotal', width: 16 },
    ];

    pedido.lineas.forEach((l) => {
      const precioUd = precioConIva(l.precioSinIva, l.ivaPercent);
      const row = sheet.addRow({
        articulo: l.articulo.nombre,
        formato: l.articulo.formato,
        cantidad: l.cantidad,
        precioUd,
        subtotal: Math.round(precioUd * l.cantidad * 100) / 100,
      });
      row.getCell('precioUd').numFmt = MONEY_FMT;
      row.getCell('subtotal').numFmt = MONEY_FMT;
    });

    const totalRow = sheet.addRow({ articulo: 'TOTAL', subtotal: Math.round(totalPorPedido(pedido) * 100) / 100 });
    totalRow.font = { bold: true };
    totalRow.getCell('subtotal').numFmt = MONEY_FMT;
    totalRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_CLARO } };
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
