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

/* H-238: la fila de la lista de gastos calculaba `(importeSinIva * (1 + iva/100)).toFixed(2)` y la API, el resumen y el Excel usan `Math.round(x*100)/100` (`importeGastoConIva`): en mitades
 * exactas difieren un céntimo (0,50 al 21 % da 0,61 en la API y 0,60 en pantalla) y al contable no le cuadraba la suma de filas con el total. Una sola fórmula. */
describe('H-238: el total con IVA de un gasto es el mismo en pantalla, API y Excel', () => {
  it('la fórmula compartida redondea la mitad hacia arriba (0,50 al 21 % = 0,61)', async () => {
    const { importeGastoConIva } = await import('@/lib/gasto-calc');
    expect(importeGastoConIva(0.5, 21).toFixed(2)).toBe('0.61');
    expect(importeGastoConIva(1.5, 21).toFixed(2)).toBe('1.82');
    expect(importeGastoConIva(0.95, 10).toFixed(2)).toBe('1.05');
  });

  it('la pantalla de gastos usa esa fórmula (no la multiplicación suelta con toFixed) en la fila y en el aviso de anulación', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const page = fs.readFileSync(path.resolve(__dirname, '../../app/admin/gastos/page.tsx'), 'utf8');
    expect(page).toContain("from '@/lib/gasto-calc'");
    expect(page).not.toMatch(/importeSinIva \* \(1 \+ [\w.]*ivaPercent \/ 100\)/);
  });
});
