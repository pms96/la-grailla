export const SHOP_CART_KEY = 'lagrailla_cart';

export type CartLine = {
  key: string;
  productId: string;
  name: string;
  price: number;
  imageUrl?: string | null;
  size?: string | null;
  color?: string | null;
  quantity: number;
};

// Sin dedup, un admin que escribe "M, M" (o repite un valor sin querer)
// genera dos claves talla/color idénticas — expandVariantKeys las duplica y
// syncProductVariants revienta al chocar con la constraint única
// @@unique([productId, size, color]) del segundo insert.
export function parseProductOptions(value?: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value.split(',')) {
    const v = raw.trim();
    if (!v) continue;
    const dedupeKey = v.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(v);
  }
  return result;
}

export type VariantKey = { size: string; color: string };

/** Cartesian product of sizes × colors. Sin opciones → una variante ""/"". */
export function expandVariantKeys(
  sizesCsv: string | null | undefined,
  colorsCsv: string | null | undefined
): VariantKey[] {
  const sizes = parseProductOptions(sizesCsv);
  const colors = parseProductOptions(colorsCsv);
  const sizeList = sizes.length > 0 ? sizes : [''];
  const colorList = colors.length > 0 ? colors : [''];
  const keys: VariantKey[] = [];
  for (const size of sizeList) {
    for (const color of colorList) {
      keys.push({ size, color });
    }
  }
  return keys;
}

export function readCart(): CartLine[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SHOP_CART_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CartLine[]) : [];
  } catch {
    return [];
  }
}

export function writeCart(cart: CartLine[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHOP_CART_KEY, JSON.stringify(cart));
  } catch {
    // Quota / private mode — ignore; UI still works in-session.
  }
}

const lineSignature = (l: { productId: string; size?: string | null; color?: string | null; quantity?: number | null }) =>
  `${l.productId}|${(l.size ?? '').trim()}|${(l.color ?? '').trim()}|${l.quantity ?? 0}`;

/**
 * ¿El carrito guardado es el de ESTE pedido? El carrito ya no se vacía al pulsar «Pagar» (si el pago falla o el comprador vuelve atrás, no
 * debe perder lo que había elegido) sino en la confirmación, cuando el pedido consta como pagado. Pero un enlace de confirmación antiguo
 * no debe vaciar un carrito NUEVO: solo se vacía si lo guardado coincide con lo pedido (mismas líneas y cantidades, en cualquier orden).
 */
export function cartMatchesOrderItems(
  cart: CartLine[],
  items: { productId: string; size?: string | null; color?: string | null; quantity: number }[]
): boolean {
  if (cart.length === 0 || cart.length !== items.length) return false;
  const a = cart.map(lineSignature).sort();
  const b = items.map(lineSignature).sort();
  return a.every((sig, i) => sig === b[i]);
}

export function cartTotals(cart: CartLine[]) {
  const totalItems = cart.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
  const totalAmount = cart.reduce((sum, l) => sum + (l.price ?? 0) * (l.quantity ?? 0), 0);
  return { totalItems, totalAmount };
}
