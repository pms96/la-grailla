import { describe, expect, it } from 'vitest';
import { parseVatRate, vatBreakdown, vatText, issuerLines } from '@/lib/fiscal';
import { fiscalEmailHtml } from '@/lib/fiscal-email';
import { legalHash } from '@/lib/legal-terms';
import { defaultTermsEntradas, defaultTermsTienda } from '@/lib/legal-defaults';
import { shopOrderEmailHtml } from '@/lib/shop/order-email';

describe('parseVatRate (P0-11)', () => {
  it('vacío o basura = no configurado; 0 SÍ es un tipo válido (exento)', () => {
    expect(parseVatRate('')).toBeNull();
    expect(parseVatRate('  ')).toBeNull();
    expect(parseVatRate(undefined)).toBeNull();
    expect(parseVatRate('abc')).toBeNull();
    expect(parseVatRate('-1')).toBeNull();
    expect(parseVatRate('101')).toBeNull();
    expect(parseVatRate('0')).toBe(0);
    expect(parseVatRate('21')).toBe(21);
    expect(parseVatRate('10,5')).toBe(10.5);
  });
});

describe('vatBreakdown: el precio ya lleva el IVA (P0-11)', () => {
  it('21 %: 10,00 € → base 8,26 + cuota 1,74', () => {
    expect(vatBreakdown(10, 21)).toEqual({ rate: 21, base: 8.26, vat: 1.74, total: 10 });
  });
  it('10 %: 11,00 € → base 10,00 + cuota 1,00', () => {
    expect(vatBreakdown(11, 10)).toEqual({ rate: 10, base: 10, vat: 1, total: 11 });
  });
  it('0 %: toda la cantidad es base', () => {
    expect(vatBreakdown(25, 0)).toEqual({ rate: 0, base: 25, vat: 0, total: 25 });
  });
  it('base + cuota siempre suman el total, sin céntimos perdidos', () => {
    for (const total of [0.01, 0.99, 3.33, 17.5, 99.99, 1234.56]) {
      for (const rate of [4, 10, 21]) {
        const b = vatBreakdown(total, rate)!;
        expect(Math.round((b.base + b.vat) * 100)).toBe(Math.round(total * 100));
      }
    }
  });
  it('sin tipo no se desglosa nada (no se inventa un IVA)', () => {
    expect(vatBreakdown(10, null)).toBeNull();
    expect(vatBreakdown(10, undefined)).toBeNull();
    expect(vatText(null)).toBe('IVA incluido');
  });
});

describe('textos del justificante', () => {
  it('el emisor solo se imprime si hay NIF (parámetro null = nada)', () => {
    expect(issuerLines(null)).toEqual([]);
    expect(issuerLines({ name: 'Acme SL', nif: 'B12345678', address: 'Calle 1, Málaga' })).toEqual(['Acme SL · NIF B12345678', 'Calle 1, Málaga']);
  });

  it('el pie del correo dice que no es factura y escapa el HTML de los datos del cliente', () => {
    const html = fiscalEmailHtml({
      issuer: { name: '<script>alert(1)</script> SL', nif: 'B1', address: '' },
      vat: vatBreakdown(11, 10),
      invoiceEmail: 'hola@acme.test',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('no es una factura');
    expect(html).toContain('hola@acme.test');
    expect(html).toContain('IVA incluido (10 %)');
  });

  it('sin datos fiscales solo queda la aclaración de que no es factura', () => {
    const html = fiscalEmailHtml({ issuer: null, vat: null, invoiceEmail: null });
    expect(html).toContain('no es una factura');
    expect(html).not.toContain('NIF');
    expect(html).not.toContain('IVA incluido');
  });

  it('el correo de la tienda lleva «Justificante de compra (no es factura)» y el pie', () => {
    const brand = { name: 'X', colors: { emailAccent: '#000' }, logo: null } as unknown as Parameters<typeof shopOrderEmailHtml>[1];
    const html = shopOrderEmailHtml(
      { id: 'abc12345xyz', buyerName: 'Ana', totalAmount: 20, items: [] },
      brand,
      'https://t.test',
      fiscalEmailHtml({ issuer: { name: 'Acme SL', nif: 'B1', address: '' }, vat: vatBreakdown(20, 21), invoiceEmail: null })
    );
    expect(html).toContain('Justificante de compra (no es factura)');
    expect(html).toContain('Acme SL');
    expect(html).toContain('NIF B1');
  });
});

describe('condiciones de venta (P0-11)', () => {
  it('el hash depende solo del contenido (mismo texto → mismo hash; cualquier cambio → otro)', () => {
    expect(legalHash('a')).toBe(legalHash('a'));
    expect(legalHash('a')).not.toBe(legalHash('a '));
    expect(legalHash('x')).toHaveLength(32);
  });

  it('el borrador de entradas dice que NO hay desistimiento y el de tienda sí lo da (14 días)', () => {
    const ctx = { name: 'Acme SL', nif: 'B1', email: 'hola@acme.test' };
    expect(defaultTermsEntradas(ctx)).toMatch(/103\.l/);
    expect(defaultTermsEntradas(ctx)).toMatch(/no se aplica/i);
    expect(defaultTermsTienda(ctx)).toMatch(/14 días naturales/);
    expect(defaultTermsTienda(ctx)).toContain('hola@acme.test');
    expect(defaultTermsEntradas(ctx)).toContain('Acme SL, con NIF B1');
  });
});
