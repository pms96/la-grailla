import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildGastosExcel } from '@/lib/gastos/gastos-excel';
import { buildGastosPdf } from '@/lib/gastos/gastos-pdf';
import type { GastosExportData } from '@/lib/gastos/gastos-data';

const data: GastosExportData = {
  temporada: { nombre: 'Feria de San Miguel 26', anio: 2026 },
  gastos: [
    {
      fecha: new Date('2026-09-25'),
      categoria: 'Bebidas y bar',
      concepto: 'Compra de cerveza',
      proveedor: 'Ramírez Velasco',
      numDocumento: 'F-001',
      tipoDocumento: 'Factura',
      importeSinIva: 100,
      ivaPercent: 21,
      importeConIva: 121,
      notas: null,
    },
    {
      fecha: new Date('2026-09-26'),
      categoria: 'Alquiler de puesto',
      concepto: 'Alquiler caseta',
      proveedor: null,
      numDocumento: null,
      tipoDocumento: 'Factura',
      importeSinIva: 200,
      ivaPercent: 21,
      importeConIva: 242,
      notas: 'Pagado en efectivo',
    },
  ],
  total: 363,
};

describe('buildGastosExcel', () => {
  it('genera un .xlsx con una fila por gasto y una fila de total', async () => {
    const buffer = await buildGastosExcel(data);
    expect(buffer.subarray(0, 2).toString('hex')).toBe('504b');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];

    const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    const colConcepto = headers.indexOf('Concepto');
    const colImporteConIva = headers.indexOf('Importe c/IVA');

    expect(sheet.getRow(2).getCell(colConcepto).value).toBe('Compra de cerveza');
    expect(sheet.getRow(3).getCell(colImporteConIva).value).toBe(242);

    const totalRow = sheet.getRow(4);
    expect(totalRow.getCell(colConcepto).value).toBe('TOTAL');
    expect(totalRow.getCell(colImporteConIva).value).toBe(363);
  });
});

describe('buildGastosPdf', () => {
  it('genera un PDF con cabecera %PDF', async () => {
    const bytes = await buildGastosPdf(data);
    expect(Buffer.from(bytes.slice(0, 4)).toString('utf8')).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(300);
  });
});
