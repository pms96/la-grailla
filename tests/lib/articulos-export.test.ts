import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildArticulosExcel } from '@/lib/compras/articulos-excel';
import { buildArticulosPdf } from '@/lib/compras/articulos-pdf';
import type { Articulo, PrecioArticulo, Proveedor } from '@prisma/client';

const proveedorRamirez: Proveedor = {
  id: 'prov-ramirez',
  nombre: 'Ramírez Velasco',
  contacto: null,
  telefono: null,
  email: null,
  notas: null,
  activo: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const proveedorJavi: Proveedor = { ...proveedorRamirez, id: 'prov-javi', nombre: 'Javi' };

const articulos: (Articulo & { precios: (PrecioArticulo & { proveedor: Proveedor })[] })[] = [
  {
    id: 'art-1',
    nombre: 'Cruzcampo 1/3',
    categoria: 'Cervezas',
    formato: 'Botella 1/3',
    unidadesPorCaja: 24,
    ivaPercent: 21,
    activo: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    precios: [
      {
        id: 'precio-1', articuloId: 'art-1', proveedorId: 'prov-ramirez', precioSinIva: 0.53, descuentoPercent: 0,
        formatoVenta: 'Caja 24', unidadMinPedido: 24, notas: null, createdAt: new Date(), updatedAt: new Date(),
        proveedor: proveedorRamirez,
      },
      {
        id: 'precio-2', articuloId: 'art-1', proveedorId: 'prov-javi', precioSinIva: 0.6, descuentoPercent: 10,
        formatoVenta: 'Caja 24', unidadMinPedido: 24, notas: null, createdAt: new Date(), updatedAt: new Date(),
        proveedor: proveedorJavi,
      },
    ],
  },
  {
    id: 'art-2',
    nombre: 'Agua 50cl',
    categoria: 'Aguas',
    formato: 'Botella 50cl',
    unidadesPorCaja: 12,
    ivaPercent: 10,
    activo: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    precios: [],
  },
];

describe('buildArticulosExcel', () => {
  it('genera un .xlsx con columnas por proveedor y marca el más barato', async () => {
    const buffer = await buildArticulosExcel(articulos);
    expect(buffer.subarray(0, 2).toString('hex')).toBe('504b');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];

    const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    const colNombre = headers.indexOf('Artículo');
    const colMejor = headers.indexOf('Proveedor más barato');
    const colEstado = headers.indexOf('Estado');
    const colPrecioRamirez = headers.indexOf('Ramírez Velasco (€ c/IVA, con dto.)');
    const colPrecioJavi = headers.indexOf('Javi (€ c/IVA, con dto.)');
    const colDtoJavi = headers.indexOf('Javi (dto. %)');

    expect(sheet.getRow(2).getCell(colNombre).value).toBe('Cruzcampo 1/3');
    expect(sheet.getRow(2).getCell(colMejor).value).toBe('Ramírez Velasco');
    expect(sheet.getRow(2).getCell(colPrecioRamirez).value).toBeCloseTo(0.64, 2);
    // Javi tiene un 10% de descuento: 0.6€ -> 0.54€ sin IVA -> 0.65€ c/IVA.
    expect(sheet.getRow(2).getCell(colPrecioJavi).value).toBeCloseTo(0.65, 2);
    expect(sheet.getRow(2).getCell(colDtoJavi).value).toBe(10);
    expect(sheet.getRow(3).getCell(colEstado).value).toBe('Inactivo');
  });
});

describe('buildArticulosPdf', () => {
  it('genera un PDF con cabecera %PDF', async () => {
    const bytes = await buildArticulosPdf(articulos);
    expect(Buffer.from(bytes.slice(0, 4)).toString('utf8')).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(300);
  });
});
