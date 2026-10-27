import { describe, it, expect } from 'vitest';
import { csvMoney, csvText, formatMadridDateTime, madridDay, shopOrdersToCsv, SHOP_ORDERS_CSV_HEADERS } from '@/lib/shop-orders-csv';

// AUDIT P0-09 / TI-04 (y CO-05): el CSV debe abrirse bien en Excel español y no ser vector de inyección de fórmulas.
describe('csvText — escudo de fórmulas y comillas', () => {
  it.each(['=1+1', '+34600123456', '-5', '@SUMA(A1)', '\tX', '\rX'])('antepone un apóstrofo a %j', (v) => {
    expect(csvText(v).replace(/^"/, '').startsWith("'")).toBe(true);
  });
  it('no toca el texto normal ni los números dentro del texto', () => {
    expect(csvText('Camiseta M')).toBe('Camiseta M');
    expect(csvText('Calle 5 - 2º')).toBe('Calle 5 - 2º');
  });
  it('entrecomilla si hay punto y coma, comillas o saltos de línea', () => {
    expect(csvText('a;b')).toBe('"a;b"');
    expect(csvText('dice "hola"')).toBe('"dice ""hola"""');
    expect(csvText('línea 1\nlínea 2')).toBe('"línea 1\nlínea 2"');
  });
  it('la coma no obliga a entrecomillar (el separador es ;)', () => {
    expect(csvText('Calle Mayor 1, 3ºA')).toBe('Calle Mayor 1, 3ºA');
  });
  it('null y undefined son celda vacía', () => {
    expect(csvText(null)).toBe('');
    expect(csvText(undefined)).toBe('');
  });
});

describe('csvMoney', () => {
  it('usa coma decimal y dos decimales', () => {
    expect(csvMoney(12.5)).toBe('12,50');
    expect(csvMoney('7')).toBe('7,00');
    expect(csvMoney(0)).toBe('0,00');
  });
});

describe('fechas en hora de Madrid', () => {
  it('invierno (UTC+1) y verano (UTC+2)', () => {
    expect(formatMadridDateTime(new Date('2026-01-15T22:30:00Z'))).toBe('15/01/2026 23:30');
    expect(formatMadridDateTime(new Date('2026-07-15T22:30:00Z'))).toBe('16/07/2026 00:30');
  });
  it('la medianoche de Madrid no sale como 24:00', () => {
    expect(formatMadridDateTime(new Date('2026-07-14T22:00:00Z'))).toBe('15/07/2026 00:00');
  });
  it('el día del fichero es el de Madrid, no el de UTC', () => {
    expect(madridDay(new Date('2026-07-14T23:30:00Z'))).toBe('2026-07-15');
  });
});

describe('shopOrdersToCsv', () => {
  const order = {
    id: 'ord1',
    createdAt: new Date('2026-07-15T22:30:00Z'),
    status: 'PAID',
    buyerName: '=HYPERLINK("http://x")',
    buyerEmail: 'ana@example.com',
    shippingPhone: '+34 600 123 456',
    shippingAddress: 'Calle Mayor 1, 3ºA',
    shippingCity: 'Madrid',
    shippingZip: '28001',
    totalAmount: 47.5,
    trackingNumber: null,
    notes: 'Llamar; antes de las 20h',
    items: [
      { quantity: 2, unitPrice: 20, size: 'M', color: 'Negro', product: { name: 'Camiseta' } },
      { quantity: 1, unitPrice: 7.5, size: null, color: null, product: { name: 'Taza' } },
    ],
  };

  it('empieza con BOM, usa ; y cabeceras en español', () => {
    const csv = shopOrdersToCsv([order]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(SHOP_ORDERS_CSV_HEADERS.join(';'));
    expect(lines[0]).toContain('telefono');
    expect(lines[0]).toContain('talla');
    expect(lines[0]).toContain('color');
  });

  it('una fila por línea con talla, color, teléfono, dirección, importes con coma y total solo en la primera', () => {
    const lines = shopOrdersToCsv([order]).slice(1).split('\r\n');
    const cols = (l: string) => l.split(';');
    const h = [...SHOP_ORDERS_CSV_HEADERS];
    const col = (row: string[], name: (typeof h)[number]) => row[h.indexOf(name)];
    const r1 = cols(lines[1]);
    const r2 = cols(lines[2]);
    expect(col(r1, 'fecha')).toBe('16/07/2026 00:30');
    expect(col(r1, 'estado')).toBe('Pagado');
    expect(col(r1, 'producto')).toBe('Camiseta');
    expect(col(r1, 'talla')).toBe('M');
    expect(col(r1, 'color')).toBe('Negro');
    expect(col(r1, 'cantidad')).toBe('2');
    expect(col(r1, 'precio_unitario')).toBe('20,00');
    expect(col(r1, 'importe_linea')).toBe('40,00');
    expect(col(r1, 'total_pedido')).toBe('47,50');
    expect(col(r1, 'telefono')).toBe("'+34 600 123 456"); // el + se neutraliza como fórmula
    expect(col(r1, 'direccion')).toBe('Calle Mayor 1, 3ºA');
    expect(col(r1, 'nombre')).toMatch(/^"'=HYPERLINK/);
    expect(col(r2, 'producto')).toBe('Taza');
    expect(col(r2, 'talla')).toBe('');
    expect(col(r2, 'total_pedido')).toBe('');
    expect(lines[1]).toContain('"Llamar; antes de las 20h"');
  });

  it('un pedido sin líneas sale en una fila', () => {
    const lines = shopOrdersToCsv([{ ...order, items: [] }]).slice(1).split('\r\n');
    expect(lines).toHaveLength(3); // cabecera + fila + vacío final
    expect(lines[1]).toContain('47,50');
  });
});
