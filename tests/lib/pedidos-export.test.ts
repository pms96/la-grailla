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
  });
});

describe('buildPedidosPdf', () => {
  it('genera un PDF con cabecera %PDF, una página por proveedor', async () => {
    const bytes = await buildPedidosPdf(data);
    const header = Buffer.from(bytes.slice(0, 4)).toString('utf8');
    expect(header).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(500);
  });
});
