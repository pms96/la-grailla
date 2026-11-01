import { describe, it, expect } from 'vitest';
import { orderRef } from '@/lib/order-ref';
import { shopOrderEmailHtml } from '@/lib/shop/order-email';
import { buildEmailHtml } from '@/lib/tickets';

/* H-136: la «referencia» eran los 8 primeros caracteres de un cuid v1: «c» + 7 del reloj (~36 ms de resolución). Dos pedidos de la misma ventana compartían
 * referencia, el correo invita a «escribir con tu referencia» para pedir factura y la búsqueda del administrador devolvía los dos. */

// Forma de un cuid v1: «c» + 8 de reloj (base36) + 4 de contador + 4 de huella + 8 aleatorios.
const cuid = (clock: string, random: string) => `c${clock}0000fp01${random}`;

describe('orderRef', () => {
  it('dos pedidos de la misma ventana de reloj tienen referencias distintas', () => {
    const a = cuid('lz1abcde', 'x7q2m9ka');
    const b = cuid('lz1abcde', 'p3t8w1zr');
    expect(a.slice(0, 8)).toBe(b.slice(0, 8)); // el defecto: la cabeza coincide
    expect(orderRef(a)).not.toBe(orderRef(b));
  });

  it('son los 8 últimos caracteres en mayúsculas, y el id de un pedido se encuentra buscando su referencia (subcadena)', () => {
    const id = cuid('lz1abcde', 'x7q2m9ka');
    expect(orderRef(id)).toBe('X7Q2M9KA');
    expect(id.toLowerCase().includes(orderRef(id).toLowerCase())).toBe(true);
  });

  it('null y undefined dan cadena vacía', () => {
    expect(orderRef(null)).toBe('');
    expect(orderRef(undefined)).toBe('');
  });
});

describe('el justificante lleva la referencia única y la fecha de la compra', () => {
  const brand = { name: 'X', colors: { emailAccent: '#000', emailTint: '#eee' }, logo: null } as never;
  const id = cuid('lz1abcde', 'x7q2m9ka');
  const createdAt = new Date('2026-07-15T22:30:00Z'); // 00:30 del 16 en Madrid

  it('tienda', () => {
    const html = shopOrderEmailHtml({ id, createdAt, buyerName: 'Ana', totalAmount: 20, items: [] }, brand, 'https://t.test');
    expect(html).toContain('X7Q2M9KA');
    expect(html).toContain('16/07/2026 00:30');
  });

  it('entradas', () => {
    const order = { id, createdAt, buyerName: 'Ana', totalAmount: 20, tickets: [], event: { name: 'Feria', venue: 'Plaza', city: 'Sevilla', date: new Date('2026-09-25T18:00:00Z') }, vatRate: null, channel: 'ONLINE' };
    const html = buildEmailHtml(order as never, 'https://t.test/print', brand, 'https://t.test');
    expect(html).toContain('X7Q2M9KA');
    expect(html).toContain('Fecha de compra');
    expect(html).toContain('16/07/2026 00:30');
  });
});
