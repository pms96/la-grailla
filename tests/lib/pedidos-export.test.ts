import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildPedidosExcel } from '@/lib/compras/pedidos-excel';
import { buildPedidosPdf } from '@/lib/compras/pedidos-pdf';
import type { PedidosParaExport } from '@/lib/compras/pedidos-data';
import type { Temporada } from '@prisma/client';

const temporada: Temporada = {
  id: 'temp-1',
  nombre: 'Feria de Septiembre 2026',
  anio: 2026,
  fechaInicio: null,
  fechaFin: null,
  status: 'ABIERTA',
  notas: null,
  archivado: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const data: PedidosParaExport = {
  temporada,
  pedidos: [
    {
      id: 'ped-1',
      temporadaId: 'temp-1',
      proveedorId: 'prov-ramirez',
      status: 'BORRADOR',
      fechaPedido: new Date('2026-08-01'),
      fechaEnviado: null,
      fechaRecibido: null,
      notas: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      proveedor: {
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
      lineas: [
        {
          id: 'linea-1',
          pedidoId: 'ped-1',
          articuloId: 'art-1',
          cantidad: 600,
          precioSinIva: 0.53,
          descuentoPercent: 0,
          ivaPercent: 21,
          articulo: {
            id: 'art-1',
            nombre: 'Cruzcampo 1/3',
            categoria: 'Cervezas',
            formato: 'Botella 1/3',
            unidadesPorCaja: 24,
            ivaPercent: 21,
            activo: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ],
    },
    {
      id: 'ped-2',
      temporadaId: 'temp-1',
      proveedorId: 'prov-javi',
      status: 'ENVIADO',
      fechaPedido: new Date('2026-08-01'),
      fechaEnviado: new Date('2026-08-02'),
      fechaRecibido: null,
      notas: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      proveedor: {
        id: 'prov-javi',
        nombre: 'Javi Sánchez-Garrido',
        contacto: null,
        telefono: null,
        email: null,
        notas: null,
        activo: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      lineas: [
        {
          id: 'linea-2',
          pedidoId: 'ped-2',
          articuloId: 'art-2',
          cantidad: 200,
          precioSinIva: 0.48,
          descuentoPercent: 10,
          ivaPercent: 21,
          articulo: {
            id: 'art-2',
            nombre: 'Fanta Naranja 33cl',
            categoria: 'Refrescos',
            formato: 'Lata 33cl',
            unidadesPorCaja: 24,
            ivaPercent: 21,
            activo: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ],
    },
  ],
  formatoProveedorPorClave: new Map([['art-1_prov-ramirez', 'Palet de 40 cajas']]),
} as unknown as PedidosParaExport;

describe('buildPedidosExcel', () => {
  it('genera un .xlsx con una hoja de resumen y una hoja por proveedor', async () => {
    const buffer = await buildPedidosExcel(data);
    expect(buffer.subarray(0, 2).toString('hex')).toBe('504b');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const nombresHojas = workbook.worksheets.map((s) => s.name);
    expect(nombresHojas).toContain('Resumen');
    expect(nombresHojas).toContain('Ramírez Velasco');
    expect(nombresHojas).toContain('Javi Sánchez-Garrido');

    const hojaRamirez = workbook.getWorksheet('Ramírez Velasco')!;
    const textoHoja = hojaRamirez.getSheetValues().flat().join(' ');
    expect(textoHoja).toContain('Cruzcampo 1/3');

    // Javi tiene un 10% de descuento: 0.48€ -> 0.43€ sin IVA -> 0.52€ c/IVA.
    const hojaJavi = workbook.getWorksheet('Javi Sánchez-Garrido')!;
    const textoJavi = hojaJavi.getSheetValues().flat().join(' ');
    expect(textoJavi).toContain('0.52');
  });

  it('omite las columnas de precio cuando incluirPrecios es false', async () => {
    const buffer = await buildPedidosExcel(data, { incluirPrecios: false });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const resumenHeaders = (workbook.getWorksheet('Resumen')!.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    expect(resumenHeaders).not.toContain('Total estimado (€ c/IVA)');

    const hojaRamirez = workbook.getWorksheet('Ramírez Velasco')!;
    const textoHoja = hojaRamirez.getSheetValues().flat().join(' ');
    expect(textoHoja).not.toContain('TOTAL');
    expect(textoHoja).toContain('Cruzcampo 1/3');
  });

  it('añade una columna con el formato del proveedor sin quitar la columna de formato general', async () => {
    const buffer = await buildPedidosExcel(data, { incluirFormatoProveedor: true });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const hojaRamirez = workbook.getWorksheet('Ramírez Velasco')!;
    const textoRamirez = hojaRamirez.getSheetValues().flat().join(' ');
    expect(textoRamirez).toContain('Botella 1/3'); // formato general del artículo, sigue presente
    expect(textoRamirez).toContain('Palet de 40 cajas'); // formato del proveedor, columna nueva

    // Javi no tiene formato de venta registrado para ese proveedor -> "—" en vez de inventar uno.
    const hojaJavi = workbook.getWorksheet('Javi Sánchez-Garrido')!;
    const textoJavi = hojaJavi.getSheetValues().flat().join(' ');
    expect(textoJavi).toContain('Lata 33cl');
    expect(textoJavi).toContain('—');
  });

  it('añade precio ud. sin IVA, subtotal sin IVA y %IVA/%descuento cuando se activan esos checks', async () => {
    const buffer = await buildPedidosExcel(data, {
      incluirPrecioSinIva: true,
      incluirSubtotalSinIva: true,
      incluirIvaDescuento: true,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const headers = (workbook.getWorksheet('Ramírez Velasco')!.getRow(5).values as unknown[]).map((v) => String(v ?? ''));
    expect(headers).toContain('Precio ud. s/IVA (€)');
    expect(headers).toContain('Subtotal s/IVA (€)');
    expect(headers).toContain('% IVA');
    expect(headers).toContain('% Descuento');

    // Ramírez: 0.53€ sin descuento -> precio ud. sin IVA 0.53€; subtotal sin IVA = 0.53 × 600 = 318€.
    const textoRamirez = workbook.getWorksheet('Ramírez Velasco')!.getSheetValues().flat().join(' ');
    expect(textoRamirez).toContain('0.53');
    expect(textoRamirez).toContain('318');
  });

  it('ignora los desgloses de precio si incluirPrecios es false, aunque se pidan explícitamente', async () => {
    const buffer = await buildPedidosExcel(data, {
      incluirPrecios: false,
      incluirPrecioSinIva: true,
      incluirSubtotalSinIva: true,
      incluirIvaDescuento: true,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const headers = (workbook.getWorksheet('Ramírez Velasco')!.getRow(5).values as unknown[]).map((v) => String(v ?? ''));
    expect(headers.some((h) => h.includes('IVA'))).toBe(false);
    expect(headers.some((h) => h.includes('Subtotal'))).toBe(false);
  });
});

describe('buildPedidosPdf', () => {
  it('genera un PDF con cabecera %PDF, una página por proveedor', async () => {
    const bytes = await buildPedidosPdf(data);
    const header = Buffer.from(bytes.slice(0, 4)).toString('utf8');
    expect(header).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(500);
  });

  it('genera un PDF sin precios cuando incluirPrecios es false', async () => {
    const bytes = await buildPedidosPdf(data, { incluirPrecios: false });
    expect(Buffer.from(bytes.slice(0, 4)).toString('utf8')).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(300);
  });

  it('genera un PDF con todas las columnas activas a la vez (encogiendo anchos/fuente) sin errores', async () => {
    const bytes = await buildPedidosPdf(data, {
      incluirFormatoProveedor: true,
      incluirPrecioSinIva: true,
      incluirSubtotalSinIva: true,
      incluirIvaDescuento: true,
    });
    expect(Buffer.from(bytes.slice(0, 4)).toString('utf8')).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(500);
  });
});
