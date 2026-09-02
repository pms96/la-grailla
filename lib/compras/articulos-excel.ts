import ExcelJS from 'exceljs';
import type { Articulo, PrecioArticulo, Proveedor } from '@prisma/client';
import { precioConIva } from '@/lib/compras/calculadora';

type ArticuloConPrecios = Articulo & { precios: (PrecioArticulo & { proveedor: Proveedor })[] };

const MORADO = 'FF3D2FD5';

export async function buildArticulosExcel(articulos: ArticuloConPrecios[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'La Grailla';
  workbook.created = new Date();

  const proveedores = Array.from(
    new Map(articulos.flatMap((a) => a.precios).map((p) => [p.proveedorId, p.proveedor.nombre])).entries()
  ).map(([proveedorId, nombre]) => ({ proveedorId, nombre }));

  const sheet = workbook.addWorksheet('Artículos', { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = [
    { header: 'Categoría', key: 'categoria', width: 16 },
    { header: 'Artículo', key: 'nombre', width: 28 },
    { header: 'Formato', key: 'formato', width: 16 },
    { header: 'Uds/caja', key: 'unidadesPorCaja', width: 10 },
    { header: 'IVA %', key: 'ivaPercent', width: 8 },
    ...proveedores.map((p, i) => ({ header: `${p.nombre} (€ c/IVA)`, key: `prov_${i}`, width: 18 })),
    { header: 'Proveedor más barato', key: 'mejor', width: 20 },
    { header: 'Estado', key: 'estado', width: 12 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MORADO } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  headerRow.height = 30;

  articulos.forEach((a) => {
    const preciosPorProveedor = new Map(a.precios.map((p) => [p.proveedorId, precioConIva(p.precioSinIva, a.ivaPercent)]));
    const mejor = a.precios.reduce<(typeof a.precios)[number] | null>((min, p) => {
      const c = precioConIva(p.precioSinIva, a.ivaPercent);
      const cMin = min ? precioConIva(min.precioSinIva, a.ivaPercent) : Infinity;
      return c < cMin ? p : min;
    }, null);

    const row: Record<string, unknown> = {
      categoria: a.categoria,
      nombre: a.nombre,
      formato: a.formato,
      unidadesPorCaja: a.unidadesPorCaja,
      ivaPercent: a.ivaPercent,
      mejor: mejor?.proveedor.nombre ?? '',
      estado: a.activo ? 'Activo' : 'Inactivo',
    };
    proveedores.forEach((p, i) => {
      row[`prov_${i}`] = preciosPorProveedor.get(p.proveedorId) ?? null;
    });
    sheet.addRow(row);
  });

  proveedores.forEach((_, i) => {
    sheet.getColumn(`prov_${i}`).numFmt = '#,##0.00 €';
  });

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
