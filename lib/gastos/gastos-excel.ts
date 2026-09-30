import ExcelJS from 'exceljs';
import type { GastosExportData } from '@/lib/gastos/gastos-data';

const MORADO = 'FF3D2FD5';
const GRIS_CLARO = 'FFF2F2F7';
const MONEY_FMT = '#,##0.00 €';

export async function buildGastosExcel(data: GastosExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'La Grailla';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Gastos', { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 14 },
    { header: 'Categoría', key: 'categoria', width: 22 },
    { header: 'Concepto', key: 'concepto', width: 30 },
    { header: 'Proveedor', key: 'proveedor', width: 22 },
    { header: 'Nº documento', key: 'numDocumento', width: 16 },
    { header: 'Tipo', key: 'tipoDocumento', width: 12 },
    { header: 'Importe s/IVA', key: 'importeSinIva', width: 16 },
    { header: '% IVA', key: 'ivaPercent', width: 10 },
    { header: 'Importe c/IVA', key: 'importeConIva', width: 16 },
    { header: 'Notas', key: 'notas', width: 32 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MORADO } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  headerRow.height = 24;

  data.gastos.forEach((g) => {
    sheet.addRow({
      fecha: g.fecha.toLocaleDateString('es-ES'),
      categoria: g.categoria,
      concepto: g.concepto,
      proveedor: g.proveedor ?? '',
      numDocumento: g.numDocumento ?? '',
      tipoDocumento: g.tipoDocumento,
      importeSinIva: g.importeSinIva,
      ivaPercent: g.ivaPercent,
      importeConIva: g.importeConIva,
      notas: g.notas ?? '',
    });
  });

  sheet.getColumn('importeSinIva').numFmt = MONEY_FMT;
  sheet.getColumn('importeConIva').numFmt = MONEY_FMT;
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

  const totalRow = sheet.addRow({ concepto: 'TOTAL', importeConIva: data.total });
  totalRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_CLARO } };
  });
  totalRow.getCell('importeConIva').numFmt = MONEY_FMT;

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
