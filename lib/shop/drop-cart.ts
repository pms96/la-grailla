import { type CartLine, readCart, writeCart } from '@/lib/shop-cart';
import { variantStock, type ShopProductView } from '@/lib/shop/product-view';

/* Operaciones del carrito de la tienda de la plantilla «drop». Son funciones PURAS sobre la lista de líneas (el carrito sigue viviendo en el
 * navegador, en la misma clave de siempre, y el checkout lo lee de ahí): cada una devuelve el carrito nuevo o el motivo por el que no se puede.
 * Reglas iguales a las de la tienda de siempre: hay que elegir talla y color si el producto los tiene, no se pasa del stock de la combinación y
 * el servidor vuelve a comprobarlo todo al crear el pedido. */

export type CartResult = { cart: CartLine[]; error: null } | { cart: CartLine[]; error: string };

export const lineKey = (productId: string, size: string, color: string): string => [productId, size, color].join('|');

/** «Solo queda 1 unidad» / «Solo quedan 3 unidades». */
const onlyLeft = (stock: number): string => (stock === 1 ? 'Solo queda 1 unidad' : `Solo quedan ${stock} unidades`);

export function addToCart(cart: readonly CartLine[], product: ShopProductView, size: string, color: string): CartResult {
  if (product.sizes.length > 0 && !size) return { cart: [...cart], error: 'Elige una talla' };
  if (product.colors.length > 0 && !color) return { cart: [...cart], error: 'Elige un color' };
  const stock = variantStock(product, size, color);
  if (stock !== null && stock <= 0) return { cart: [...cart], error: 'Agotado en esta combinación' };
  const key = lineKey(product.id, size, color);
  const inCart = cart.find((l) => l.key === key)?.quantity ?? 0;
  if (stock !== null && inCart + 1 > stock) return { cart: [...cart], error: onlyLeft(stock) };
  if (inCart > 0) return { cart: cart.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l)), error: null };
  return {
    cart: [
      ...cart,
      { key, productId: product.id, name: product.name, price: product.price, imageUrl: product.imageUrl, size: size || null, color: color || null, quantity: 1 },
    ],
    error: null,
  };
}

/** Cambia la cantidad de una línea (0 la quita). `stockOf` da el stock de esa línea si se conoce (null = sin límite en el navegador). */
export function changeQuantity(cart: readonly CartLine[], key: string, delta: number, stockOf?: (line: CartLine) => number | null): CartResult {
  const line = cart.find((l) => l.key === key);
  if (!line) return { cart: [...cart], error: null };
  const next = line.quantity + delta;
  if (delta > 0) {
    const stock = stockOf?.(line) ?? null;
    if (stock !== null && next > stock) return { cart: [...cart], error: `${onlyLeft(stock)} de ${line.name}` };
  }
  return { cart: cart.map((l) => (l.key === key ? { ...l, quantity: next } : l)).filter((l) => l.quantity > 0), error: null };
}

export const removeLine = (cart: readonly CartLine[], key: string): CartLine[] => cart.filter((l) => l.key !== key);

/** Evento que avisa a los componentes de la misma página de que el carrito cambió (el evento `storage` solo llega a OTRAS pestañas). */
export const CART_CHANGED_EVENT = 'grailla:cart-changed';
export const CART_OPEN_EVENT = 'grailla:cart-open';

export function saveCart(cart: CartLine[]): void {
  writeCart(cart);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CART_CHANGED_EVENT));
}

export function openCart(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CART_OPEN_EVENT));
}

export { readCart };
