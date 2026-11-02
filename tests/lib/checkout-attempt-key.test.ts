import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attemptKey, shopAttemptFingerprint, ticketAttemptFingerprint } from '@/lib/checkout-attempt-key';

/* H-214 (cliente): la clave de idempotencia vive mientras el comprador no cambie lo que compra. Tras «atrás» desde la pasarela (la página vuelve de la caché con su estado) o tras un
 * fallo de red, un reintento IGUAL conserva la clave (no se cobra dos veces) y uno DISTINTO la renueva (no se le devuelve el pedido anterior). */

const ids = (() => {
  let n = 0;
  return () => `k${++n}`;
})();

describe('attemptKey', () => {
  it('sin intento previo crea una clave nueva', () => {
    expect(attemptKey(null, 'fp', ids).key).toMatch(/^k\d+$/);
  });
  it('con la misma huella conserva la clave', () => {
    const first = attemptKey(null, 'fp', ids);
    expect(attemptKey(first, 'fp', ids)).toBe(first);
  });
  it('con otra huella renueva la clave', () => {
    const first = attemptKey(null, 'fp-1', ids);
    const second = attemptKey(first, 'fp-2', ids);
    expect(second.key).not.toBe(first.key);
    expect(second.fingerprint).toBe('fp-2');
  });
});

describe('huellas', () => {
  it('entradas: no depende del orden de las líneas ni de mayúsculas del email, sí de cantidad, tipo, evento y email', () => {
    const a = ticketAttemptFingerprint('ev', ' Ana@X.com ', [{ ticketTypeId: 'a', quantity: 2 }, { ticketTypeId: 'b', quantity: 1 }]);
    expect(ticketAttemptFingerprint('ev', 'ana@x.com', [{ ticketTypeId: 'b', quantity: 1 }, { ticketTypeId: 'a', quantity: 2 }])).toBe(a);
    expect(ticketAttemptFingerprint('ev', 'ana@x.com', [{ ticketTypeId: 'a', quantity: 4 }, { ticketTypeId: 'b', quantity: 1 }])).not.toBe(a);
    expect(ticketAttemptFingerprint('ev2', 'ana@x.com', [{ ticketTypeId: 'a', quantity: 2 }, { ticketTypeId: 'b', quantity: 1 }])).not.toBe(a);
    expect(ticketAttemptFingerprint('ev', 'otra@x.com', [{ ticketTypeId: 'a', quantity: 2 }, { ticketTypeId: 'b', quantity: 1 }])).not.toBe(a);
  });
  it('tienda: la variante cuenta; sin talla ni color da igual null que vacío', () => {
    const a = shopAttemptFingerprint('Luis@x.com', [{ productId: 'p', quantity: 1, size: 'M', color: 'Negro' }, { productId: 'q', quantity: 2 }]);
    expect(shopAttemptFingerprint('luis@x.com', [{ productId: 'q', quantity: 2, size: null, color: null }, { productId: 'p', quantity: 1, size: 'M', color: 'Negro' }])).toBe(a);
    expect(shopAttemptFingerprint('luis@x.com', [{ productId: 'p', quantity: 1, size: 'L', color: 'Negro' }, { productId: 'q', quantity: 2 }])).not.toBe(a);
  });
});

describe('los dos checkouts usan la clave ligada a la huella', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  it.each([
    ['app/(public)/eventos/[slug]/comprar/_components/buy-tickets-form.tsx', 'ticketAttemptFingerprint'],
    ['app/(public)/tienda/checkout/_components/shop-checkout-client.tsx', 'shopAttemptFingerprint'],
  ])('%s', (file, fingerprint) => {
    const src = read(file);
    expect(src).toContain('attemptKey(');
    expect(src).toContain(`${fingerprint}(`);
    // Ya no se reutiliza una clave suelta sin comprobar lo que se compra.
    expect(src).not.toMatch(/idempotencyKeyRef\.current\s*=\s*crypto\.randomUUID\(\)/);
  });
});
