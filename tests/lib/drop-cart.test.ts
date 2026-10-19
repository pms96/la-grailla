import { describe, expect, it } from 'vitest';
import type { CartLine } from '@/lib/shop-cart';
import { addToCart, changeQuantity, lineKey, removeLine } from '@/lib/shop/drop-cart';
import { toProductView } from '@/lib/shop/product-view';

const shirt = toProductView({
  id: 'p1',
  slug: 'camiseta',
  name: 'Camiseta',
  price: 19,
  imageUrl: 'https://x.test/a.jpg',
  sizes: 'S, M',
  colors: 'Negro',
  variants: [
    { size: 'S', color: 'Negro', stock: 2 },
    { size: 'M', color: 'Negro', stock: 0 },
  ],
});
const poster = toProductView({ id: 'p2', slug: 'poster', name: 'Póster', price: 8, variants: [] });

describe('addToCart: las reglas de siempre de la tienda', () => {
  it('hay que elegir talla y color si el producto los tiene', () => {
    expect(addToCart([], shirt, '', 'Negro')).toMatchObject({ error: 'Elige una talla', cart: [] });
    expect(addToCart([], shirt, 'S', '')).toMatchObject({ error: 'Elige un color' });
  });

  it('una combinación agotada o inexistente no se añade', () => {
    expect(addToCart([], shirt, 'M', 'Negro').error).toBe('Agotado en esta combinación');
    expect(addToCart([], shirt, 'S', 'Negro').error).toBeNull();
  });

  it('añade la línea con su clave y opciones; la segunda vez suma, y no pasa del stock', () => {
    const first = addToCart([], shirt, 'S', 'Negro');
    expect(first.cart).toEqual([
      { key: lineKey('p1', 'S', 'Negro'), productId: 'p1', name: 'Camiseta', price: 19, imageUrl: 'https://x.test/a.jpg', size: 'S', color: 'Negro', quantity: 1 },
    ]);
    const second = addToCart(first.cart, shirt, 'S', 'Negro');
    expect(second.cart[0]!.quantity).toBe(2);
    const third = addToCart(second.cart, shirt, 'S', 'Negro');
    expect(third.error).toBe('Solo quedan 2 unidades');
    expect(third.cart[0]!.quantity).toBe(2);
  });

  it('un producto sin variantes no controla stock y no pide opciones', () => {
    let cart: CartLine[] = [];
    for (let i = 0; i < 20; i++) cart = addToCart(cart, poster, '', '').cart;
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({ size: null, color: null, quantity: 20 });
  });

  it('no modifica el carrito de entrada', () => {
    const input: CartLine[] = [];
    addToCart(input, poster, '', '');
    expect(input).toEqual([]);
  });
});

describe('changeQuantity y removeLine', () => {
  const cart = addToCart(addToCart([], poster, '', '').cart, shirt, 'S', 'Negro').cart;
  const shirtKey = lineKey('p1', 'S', 'Negro');

  it('sube y baja; llegar a 0 quita la línea', () => {
    const up = changeQuantity(cart, lineKey('p2', '', ''), 1);
    expect(up.cart.find((l) => l.productId === 'p2')!.quantity).toBe(2);
    const gone = changeQuantity(cart, lineKey('p2', '', ''), -1);
    expect(gone.cart.map((l) => l.productId)).toEqual(['p1']);
  });

  it('con el stock conocido, no deja subir por encima (y lo dice con el nombre)', () => {
    const stockOf = () => 1;
    const res = changeQuantity(cart, shirtKey, 1, stockOf);
    expect(res.error).toBe('Solo queda 1 unidad de Camiseta');
    expect(res.cart.find((l) => l.key === shirtKey)!.quantity).toBe(1);
    expect(changeQuantity(cart, shirtKey, -1, stockOf).cart.find((l) => l.key === shirtKey)).toBeUndefined(); // bajar siempre se puede
  });

  it('una clave que no existe no cambia nada; removeLine quita solo esa línea', () => {
    expect(changeQuantity(cart, 'no-existe', 1).cart).toEqual(cart);
    expect(removeLine(cart, shirtKey).map((l) => l.key)).toEqual([lineKey('p2', '', '')]);
  });
});
