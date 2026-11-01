import { describe, it, expect } from 'vitest';
import { cartTotalCents, applyServerPrices, withoutProduct, type CartLine } from '@/lib/shop-cart';

const line = (over: Partial<CartLine>): CartLine => ({ key: 'k', productId: 'p1', name: 'Gorra', price: 25, quantity: 1, ...over });

describe('cartTotalCents', () => {
  it('suma en céntimos enteros, sin error de coma flotante', () => {
    expect(cartTotalCents([line({ price: 25, quantity: 2 })])).toBe(5000);
    expect(cartTotalCents([line({ price: 0.1, quantity: 3 }), line({ key: 'k2', productId: 'p2', price: 0.2, quantity: 1 })])).toBe(50);
    expect(cartTotalCents([line({ price: 0.29, quantity: 1 })])).toBe(29); // 0.29 * 100 = 28.999999999999996 en coma flotante
    expect(cartTotalCents([])).toBe(0);
  });
});

describe('applyServerPrices', () => {
  it('actualiza el precio de cada línea con el que dice el servidor (el que no cambió, igual) y no muta el original', () => {
    const cart = [line({ productId: 'p1', price: 25 }), line({ key: 'k2', productId: 'p2', price: 10 })];
    const out = applyServerPrices(cart, [{ productId: 'p1', unitPrice: 30 }, { productId: 'p2', unitPrice: 10 }]);
    expect(out.map((l) => l.price)).toEqual([30, 10]);
    expect(cart[0].price).toBe(25);
  });
  it('una línea cuyo producto ya no está disponible (no viene en la respuesta) se quita del carrito', () => {
    const cart = [line({ productId: 'p1' }), line({ key: 'k2', productId: 'gone' })];
    expect(applyServerPrices(cart, [{ productId: 'p1', unitPrice: 25 }]).map((l) => l.productId)).toEqual(['p1']);
  });
});

describe('withoutProduct', () => {
  it('quita todas las líneas de un producto (cualquier talla y color) y no muta el original', () => {
    const cart = [line({ key: 'a', productId: 'p1' }), line({ key: 'b', productId: 'p1', size: 'L' }), line({ key: 'c', productId: 'p2' })];
    expect(withoutProduct(cart, 'p1').map((l) => l.key)).toEqual(['c']);
    expect(cart).toHaveLength(3);
  });
});
