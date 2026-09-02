import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildProveedoresExcel } from '@/lib/compras/proveedores-excel';
import { buildProveedoresPdf } from '@/lib/compras/proveedores-pdf';
import type { Proveedor } from '@prisma/client';

const proveedores: Proveedor[] = [
  {
    id: 'prov-ramirez',
    nombre: 'Ramírez Velasco',
    contacto: 'Francisco Ramírez',
    telefono: '957531027',
    email: 'distribramirez@hotmail.com',
    notas: null,
    activo: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'prov-javi',
    nombre: 'Javi Sánchez-Garrido',
    contacto: null,
    telefono: null,
    email: null,
    notas: 'Solo pedidos grandes',
    activo: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

describe('buildProveedoresExcel', () => {
  it('genera un .xlsx con una fila por proveedor y el estado correcto', async () => {
    const buffer = await buildProveedoresExcel(proveedores);
    expect(buffer.subarray(0, 2).toString('hex')).toBe('504b');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];

    const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    const colNombre = headers.indexOf('Nombre');
    const colEstado = headers.indexOf('Estado');

    expect(sheet.getRow(2).getCell(colNombre).value).toBe('Ramírez Velasco');
    expect(sheet.getRow(2).getCell(colEstado).value).toBe('Activo');
    expect(sheet.getRow(3).getCell(colEstado).value).toBe('Inactivo');
  });
});

describe('buildProveedoresPdf', () => {
  it('genera un PDF con cabecera %PDF', async () => {
    const bytes = await buildProveedoresPdf(proveedores);
    expect(Buffer.from(bytes.slice(0, 4)).toString('utf8')).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(300);
  });
});
