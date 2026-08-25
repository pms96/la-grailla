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

export function parseProductOptions(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
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

export function cartTotals(cart: CartLine[]) {
  const totalItems = cart.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
  const totalAmount = cart.reduce((sum, l) => sum + (l.price ?? 0) * (l.quantity ?? 0), 0);
  return { totalItems, totalAmount };
}
