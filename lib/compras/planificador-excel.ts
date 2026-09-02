import ExcelJS from 'exceljs';
import type { Temporada } from '@prisma/client';
import type { FilaPlanificador } from '@/lib/compras/planificador-data';

const MORADO = 'FF3D2FD5';
const GRIS_CLARO = 'FFF2F2F7';

export async function buildPlanificadorExcel(
  temporada: Temporada,
  temporadaAnterior: Temporada | null,
  filas: FilaPlanificador[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'La Grailla';
  workbook.created = new Date();

  const proveedores = Array.from(
    new Map(filas.flatMap((f) => f.precios).map((p) => [p.proveedorId, p.proveedorNombre])).entries()
  ).map(([proveedorId, nombre]) => ({ proveedorId, nombre }));

  const sheet = workbook.addWorksheet(`Planificador ${temporada.anio}`, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'Categoría', key: 'categoria', width: 18 },
    { header: 'Artículo', key: 'nombre', width: 28 },
    { header: 'Formato', key: 'formato', width: 16 },
    ...proveedores.map((p, i) => ({ header: `${p.nombre} (€ c/IVA)`, key: `prov_${i}`, width: 18 })),
    { header: 'Proveedor recomendado', key: 'recomendado', width: 20 },
    { header: 'Proveedor elegido', key: 'elegido', width: 20 },
    { header: 'Precio elegido (€ c/IVA)', key: 'precioElegido', width: 18 },
    { header: 'Ud. mínima proveedor elegido', key: 'minElegido', width: 18 },
    { header: 'Ahorro vs. más caro (€/ud)', key: 'ahorro', width: 20 },
    { header: `Consumo ref. ${temporadaAnterior?.nombre ?? ''}`, key: 'consumoRef', width: 20 },
    { header: `Cantidad planificada ${temporada.anio}`, key: 'cantidad', width: 20 },
    { header: 'Coste total estimado (€)', key: 'coste', width: 20 },
    { header: 'Ahorro total (vs. más caro)', key: 'ahorroTotal', width: 20 },
    { header: 'Sobrecoste (vs. recomendado)', key: 'sobrecoste', width: 22 },
    { header: 'Observaciones', key: 'observaciones', width: 28 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MORADO } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  headerRow.height = 32;

  filas.forEach((f) => {
    const preciosPorProveedor = new Map(f.precios.map((p) => [p.proveedorId, p.precioConIva]));
    const precioElegido = f.precios.find((p) => p.proveedorId === f.proveedorElegidoId);
    const row: Record<string, unknown> = {
      categoria: f.categoria,
      nombre: f.nombre,
      formato: f.formato,
      recomendado: f.recomendado?.proveedorNombre ?? '',
      elegido: precioElegido?.proveedorNombre ?? '',
      precioElegido: precioElegido?.precioConIva ?? null,
      minElegido: precioElegido?.unidadMinPedido ?? null,
      ahorro: f.ahorroUnidad || null,
      consumoRef: f.consumoReferencia?.cantidadNeta ?? null,
      cantidad: f.cantidadPlanificada,
      coste: f.costeTotalEstimado,
      ahorroTotal: f.ahorroTotalEstimado || null,
      sobrecoste: f.sobrecosteFrenteARecomendado || null,
      observaciones: f.observaciones,
    };
    proveedores.forEach((p, i) => {
      row[`prov_${i}`] = preciosPorProveedor.get(p.proveedorId) ?? null;
    });
    sheet.addRow(row);
  });

  const moneyCols = ['precioElegido', 'ahorro', 'coste', 'ahorroTotal', 'sobrecoste', ...proveedores.map((_, i) => `prov_${i}`)];
  moneyCols.forEach((key) => {
    const col = sheet.getColumn(key);
    col.numFmt = '#,##0.00 €';
  });

  const totalRow = sheet.addRow({
    nombre: 'TOTALES',
    cantidad: filas.reduce((sum, f) => sum + f.cantidadPlanificada, 0),
    coste: filas.reduce((sum, f) => sum + f.costeTotalEstimado, 0),
    ahorroTotal: Math.round(filas.reduce((sum, f) => sum + f.ahorroTotalEstimado, 0) * 100) / 100,
    sobrecoste: Math.round(filas.reduce((sum, f) => sum + f.sobrecosteFrenteARecomendado, 0) * 100) / 100,
  });
  totalRow.font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_CLARO } };
  });
  totalRow.getCell('coste').numFmt = '#,##0.00 €';
  totalRow.getCell('ahorroTotal').numFmt = '#,##0.00 €';
  totalRow.getCell('sobrecoste').numFmt = '#,##0.00 €';

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
