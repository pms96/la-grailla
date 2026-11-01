import { describe, it, expect } from 'vitest';
import { ORDERS_CSV_HEADERS, ATTENDEES_CSV_HEADERS, ordersToCsv, attendeesToCsv, ORDERS_CSV_MAX, TICKETS_CSV_MAX } from '@/lib/orders-csv';

/* H-137: el CSV de ventas era lo único del panel que Excel español abría mal: coma como separador y punto decimal (el importe «20.00» se partía o se leía como
 * fecha), fechas ISO en UTC (la venta de las 00:30 de Madrid aparecía el día anterior) y sin columna de estado (con el filtro «Todos» no se distinguía lo
 * cobrado de lo cancelado). Mismo formato que el CSV de tienda: «;», coma decimal, BOM, CRLF y hora de Madrid. */

const order = {
  id: 'ord1',
  createdAt: new Date('2026-07-15T22:30:00Z'),
  status: 'COMPLETED',
  event: { name: 'Feria; "grande"' },
  buyerName: '=HYPERLINK("http://x")',
  buyerLastName: 'García, Pérez',
  buyerEmail: 'ana@example.com',
  channel: 'ONLINE',
  paymentMethod: 'CARD',
  totalAmount: { toFixed: (d: number) => (33.5).toFixed(d) },
  commission: { toFixed: (d: number) => (1.5).toFixed(d) },
  _count: { tickets: 2 },
};

const split = (line: string) => line.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
const col = (row: string[], name: (typeof ORDERS_CSV_HEADERS)[number]) => row[[...ORDERS_CSV_HEADERS].indexOf(name)];

describe('ordersToCsv', () => {
  it('BOM, separador «;», CRLF y cabecera con estado', () => {
    const csv = ordersToCsv([order]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(ORDERS_CSV_HEADERS.join(';'));
    expect(lines[0]).toContain('estado');
    expect(lines.at(-1)).toBe('');
  });

  it('importes con coma, fecha de Madrid y estado en español', () => {
    const row = split(ordersToCsv([order]).slice(1).split('\r\n')[1]);
    expect(col(row, 'fecha')).toBe('16/07/2026 00:30');
    expect(col(row, 'estado')).toBe('Completado');
    expect(col(row, 'importe')).toBe('33,50');
    expect(col(row, 'comision')).toBe('1,50');
    expect(col(row, 'importe_cobrado')).toBe('33,50');
    expect(col(row, 'entradas')).toBe('2');
  });

  it('un pedido cancelado, reembolsado o pendiente no suma en «importe_cobrado»', () => {
    for (const status of ['CANCELLED', 'REFUNDED', 'PENDING']) {
      const row = split(ordersToCsv([{ ...order, status }]).slice(1).split('\r\n')[1]);
      expect(col(row, 'importe')).toBe('33,50');
      expect(col(row, 'importe_cobrado')).toBe('0,00');
    }
  });

  it('neutraliza fórmulas y entrecomilla el punto y coma', () => {
    const line = ordersToCsv([order]).slice(1).split('\r\n')[1];
    expect(line).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(line).toContain('"Feria; ""grande"""');
  });
});

describe('attendeesToCsv', () => {
  const ticket = {
    id: 't1',
    event: { name: 'Feria' },
    holderName: 'Luis',
    ticketType: { name: 'General' },
    status: 'USED',
    entryTime: new Date('2026-07-15T22:30:00Z'),
    qrCode: 'QR1',
    order: { id: 'ord1', buyerName: 'Ana', buyerLastName: 'Gil', buyerEmail: 'ana@example.com', channel: 'ONLINE' },
  };

  it('misma convención: BOM, «;», hora de Madrid', () => {
    const csv = attendeesToCsv([ticket]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(ATTENDEES_CSV_HEADERS.join(';'));
    const row = lines[1].split(';');
    expect(row[[...ATTENDEES_CSV_HEADERS].indexOf('entrada')]).toBe('16/07/2026 00:30');
    expect(row[[...ATTENDEES_CSV_HEADERS].indexOf('comprador')]).toBe('Ana Gil');
  });

  it('sin hora de entrada la celda va vacía', () => {
    const row = attendeesToCsv([{ ...ticket, entryTime: null }]).slice(1).split('\r\n')[1].split(';');
    expect(row[[...ATTENDEES_CSV_HEADERS].indexOf('entrada')]).toBe('');
  });
});

describe('topes', () => {
  it('son los que ya había, ahora con aviso en lugar de truncar', () => {
    expect(ORDERS_CSV_MAX).toBe(5000);
    expect(TICKETS_CSV_MAX).toBe(10000);
  });
});
