import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Proveedor, Temporada } from '@prisma/client';
import { pdfText } from '@/lib/pdf-safe';
import { buildGastosPdf } from '@/lib/gastos/gastos-pdf';
import { buildArticulosPdf } from '@/lib/compras/articulos-pdf';
import { buildProveedoresPdf } from '@/lib/compras/proveedores-pdf';
import { buildPlanificadorPdf } from '@/lib/compras/planificador-pdf';
import { buildPedidosPdf } from '@/lib/compras/pedidos-pdf';
import type { GastosExportData } from '@/lib/gastos/gastos-data';
import type { FilaPlanificador } from '@/lib/compras/planificador-data';
import type { PedidosParaExport } from '@/lib/compras/pedidos-data';

/* H-139: Helvetica estándar solo codifica WinAnsi. Un concepto con «🍺», «ł» o un salto de línea hacía que pdf-lib lanzara al medir o dibujar y la exportación
 * completa respondía 500. Los datos vienen de personas (conceptos, nombres de proveedor y de artículo): ninguno puede tumbar el documento. */

const RAROS = '🍺 Cañas Łódź\nsegunda línea\ttab';

const esPdf = (bytes: Uint8Array) => Buffer.from(bytes.slice(0, 5)).toString('latin1') === '%PDF-';

describe('pdfText', () => {
  it('conserva lo que Helvetica codifica (tildes, ñ, €, guiones largos, comillas tipográficas)', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    expect(pdfText(font, 'Cañas, café — 12,50 € “ok” …')).toBe('Cañas, café — 12,50 € “ok” …');
  });

  it('sustituye lo que no codifica y convierte saltos de línea y tabuladores en espacios', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const out = pdfText(font, RAROS);
    expect(out).not.toMatch(/[\n\r\t]/);
    expect(out).not.toContain('🍺');
    expect(() => font.widthOfTextAtSize(out, 9)).not.toThrow();
    expect(out).toContain('Cañas');
    expect(out).toContain('segunda línea tab'); // saltos y tabuladores pasan a espacio, no a «?»
  });

  it('null y undefined son cadena vacía', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    expect(pdfText(font, null)).toBe('');
    expect(pdfText(font, undefined)).toBe('');
  });
});

const temporada = { id: 't1', nombre: `Feria ${RAROS}`, anio: 2026 } as unknown as Temporada;
const proveedor = { id: 'p1', nombre: `Prov ${RAROS}`, contacto: RAROS, telefono: RAROS, email: RAROS, notas: RAROS, activo: true, createdAt: new Date(), updatedAt: new Date() } as Proveedor;

describe('los PDFs de exportación no se caen con texto fuera de WinAnsi (H-139)', () => {
  it('gastos', async () => {
    const data: GastosExportData = {
      temporada: { nombre: temporada.nombre, anio: 2026 },
      gastos: [
        { fecha: new Date('2026-09-25'), categoria: RAROS, concepto: RAROS, proveedor: RAROS, numDocumento: RAROS, tipoDocumento: 'Factura', importeSinIva: 10, ivaPercent: 21, importeConIva: 12.1, notas: RAROS },
      ],
      total: 12.1,
    };
    expect(esPdf(await buildGastosPdf(data))).toBe(true);
  });

  it('proveedores', async () => {
    expect(esPdf(await buildProveedoresPdf([proveedor]))).toBe(true);
  });

  it('artículos', async () => {
    const articulo = {
      id: 'a1', nombre: RAROS, categoria: RAROS, formato: RAROS, unidadesPorCaja: 24, ivaPercent: 21, activo: true, createdAt: new Date(), updatedAt: new Date(),
      precios: [{ id: 'x', articuloId: 'a1', proveedorId: 'p1', precioSinIva: 1, descuentoPercent: 0, formatoVenta: RAROS, unidadMinPedido: 1, notas: RAROS, createdAt: new Date(), updatedAt: new Date(), proveedor }],
    };
    expect(esPdf(await buildArticulosPdf([articulo as never]))).toBe(true);
  });

  it('planificador', async () => {
    const fila: FilaPlanificador = {
      articuloId: 'a1', nombre: RAROS, categoria: RAROS, formato: RAROS, unidadesPorCaja: 24, ivaPercent: 21,
      precios: [{ proveedorId: 'p1', proveedorNombre: RAROS, precioSinIva: 1, descuentoPercent: 0, precioConIva: 1.21, formatoVenta: RAROS, unidadMinPedido: 1 }],
      recomendado: { proveedorId: 'p1', proveedorNombre: RAROS, precioConIva: 1.21 },
      ahorroUnidad: 0, ahorroTotalEstimado: 0, sobrecosteFrenteARecomendado: 0,
      consumoReferencia: { temporadaNombre: RAROS, cantidadNeta: 3 },
      proveedorElegidoId: 'p1', cantidadPlanificada: 2, observaciones: RAROS, costeTotalEstimado: 2.42,
    };
    expect(esPdf(await buildPlanificadorPdf(temporada, temporada, [fila]))).toBe(true);
  });

  it('pedidos a proveedor', async () => {
    const data = {
      temporada,
      pedidos: [
        {
          id: 'ped1', temporadaId: 't1', proveedorId: 'p1', status: 'BORRADOR', fechaPedido: new Date('2026-09-01'), proveedor,
          lineas: [{ id: 'l1', cantidad: 2, precioSinIva: 1, descuentoPercent: 0, ivaPercent: 21, articulo: { id: 'a1', nombre: RAROS, formato: RAROS }, articuloId: 'a1' }],
        },
      ],
      formatoProveedorPorClave: new Map([['a1_p1', RAROS]]),
    } as unknown as PedidosParaExport;
    expect(esPdf(await buildPedidosPdf(data, { incluirFormato: true, incluirFormatoProveedor: true, incluirPrecioSinIva: true, incluirPrecioConIva: true, incluirIvaDescuento: true }))).toBe(true);
  });
});
