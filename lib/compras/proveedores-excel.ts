import ExcelJS from 'exceljs';
import type { Proveedor } from '@prisma/client';

const MORADO = 'FF3D2FD5';

export async function buildProveedoresExcel(proveedores: Proveedor[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'La Grailla';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Proveedores', { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = [
    { header: 'Nombre', key: 'nombre', width: 28 },
    { header: 'Contacto', key: 'contacto', width: 22 },
    { header: 'Teléfono', key: 'telefono', width: 16 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'Estado', key: 'estado', width: 12 },
    { header: 'Notas', key: 'notas', width: 32 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MORADO } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  headerRow.height = 24;

  proveedores.forEach((p) => {
    sheet.addRow({
      nombre: p.nombre,
      contacto: p.contacto ?? '',
      telefono: p.telefono ?? '',
      email: p.email ?? '',
      estado: p.activo ? 'Activo' : 'Inactivo',
      notas: p.notas ?? '',
    });
  });

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
