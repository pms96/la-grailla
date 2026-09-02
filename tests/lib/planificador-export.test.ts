import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildPlanificadorExcel } from '@/lib/compras/planificador-excel';
import { buildPlanificadorPdf } from '@/lib/compras/planificador-pdf';
import type { FilaPlanificador } from '@/lib/compras/planificador-data';
import type { Temporada } from '@prisma/client';

const temporada: Temporada = {
  id: 'temp-1',
  nombre: 'Feria de Septiembre 2026',
  anio: 2026,
  fechaInicio: null,
  fechaFin: null,
  status: 'ABIERTA',
  notas: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const temporadaAnterior: Temporada = { ...temporada, id: 'temp-0', nombre: 'Feria de Septiembre 2025', anio: 2025 };

const filas: FilaPlanificador[] = [
  {
    articuloId: 'art-1',
    nombre: 'Cruzcampo 1/3',
    categoria: 'Cervezas',
    formato: 'Botella 1/3',
    unidadesPorCaja: 24,
    ivaPercent: 21,
    precios: [
      { proveedorId: 'prov-ramirez', proveedorNombre: 'Ramírez Velasco', precioSinIva: 0.53, precioConIva: 0.64, formatoVenta: 'Caja 24', unidadMinPedido: 24 },
      { proveedorId: 'prov-javi', proveedorNombre: 'Javi', precioSinIva: 0.6, precioConIva: 0.73, formatoVenta: 'Caja 24', unidadMinPedido: 24 },
    ],
    recomendado: { proveedorId: 'prov-ramirez', proveedorNombre: 'Ramírez Velasco', precioConIva: 0.64 },
    ahorroUnidad: 0.09,
    consumoReferencia: { temporadaNombre: 'Feria de Septiembre 2025', cantidadNeta: 480 },
    proveedorElegidoId: 'prov-ramirez',
    cantidadPlanificada: 600,
    observaciones: 'Pedir con antelación',
    costeTotalEstimado: 384,
  },
  {
    articuloId: 'art-2',
    nombre: 'Agua 50cl',
    categoria: 'Aguas',
    formato: 'Botella 50cl',
    unidadesPorCaja: 12,
    ivaPercent: 10,
    precios: [],
    recomendado: null,
    ahorroUnidad: 0,
    consumoReferencia: null,
    proveedorElegidoId: null,
    cantidadPlanificada: 0,
    observaciones: '',
    costeTotalEstimado: 0,
  },
];

describe('buildPlanificadorExcel', () => {
  it('genera un .xlsx legible con las filas y el total esperado', async () => {
    const buffer = await buildPlanificadorExcel(temporada, temporadaAnterior, filas);
    expect(buffer.subarray(0, 2).toString('hex')).toBe('504b'); // firma ZIP de un .xlsx

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];

    // Tras recargar desde el buffer, ExcelJS pierde las `key` de columna:
    // se localizan por índice según el orden definido en buildPlanificadorExcel
    // (categoria, nombre, formato, <precio por proveedor...>, recomendado, elegido,
    // precioElegido, ahorro, consumoRef, cantidad, coste, observaciones).
    const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    const colNombre = headers.indexOf('Artículo');
    const colCoste = headers.indexOf('Coste total estimado (€)');
    const colCantidad = headers.indexOf(`Cantidad planificada ${temporada.anio}`);

    expect(sheet.getRow(2).getCell(colNombre).value).toBe('Cruzcampo 1/3');
    expect(sheet.getRow(2).getCell(colCoste).value).toBe(384);

    const totalRow = sheet.getRow(sheet.rowCount);
    expect(totalRow.getCell(colNombre).value).toBe('TOTALES');
    expect(totalRow.getCell(colCoste).value).toBe(384);
    expect(totalRow.getCell(colCantidad).value).toBe(600);
  });
});

describe('buildPlanificadorPdf', () => {
  it('genera un PDF con cabecera %PDF', async () => {
    const bytes = await buildPlanificadorPdf(temporada, temporadaAnterior, filas);
    const header = Buffer.from(bytes.slice(0, 4)).toString('utf8');
    expect(header).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(500);
  });

  it('pagina correctamente con muchas filas sin lanzar error', async () => {
    const muchasFilas: FilaPlanificador[] = Array.from({ length: 80 }, (_, i) => ({
      ...filas[0],
      articuloId: `art-${i}`,
      nombre: `Artículo ${i}`,
    }));
    const bytes = await buildPlanificadorPdf(temporada, null, muchasFilas);
    expect(Buffer.from(bytes.slice(0, 4)).toString('utf8')).toBe('%PDF');
  });
});
