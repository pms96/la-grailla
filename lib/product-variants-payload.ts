import { expandVariantKeys } from '@/lib/shop-cart';

export type VariantPayloadRow = {
  size: string | null;
  color: string | null;
  stock: number;
  /** Stock que el admin veía al abrir el formulario (solo en variantes existentes cuyo stock ha cambiado). */
  expectedStock?: number;
};

export function variantKey(size: string, color: string): string {
  return `${size}|${color}`;
}

/**
 * Qué `variants` manda el formulario de producto al guardar, o `undefined` si no hay nada que sincronizar.
 *
 * Solo se manda lo que el admin ha cambiado de verdad: guardar un producto (p.ej. solo el precio) no toca el stock, ni lo pisa con el
 * valor que se cargó al abrir el diálogo (las ventas hechas entre medias se perderían), ni deja el producto "Agotado" por crear filas
 * a 0 que nunca existieron. Por cada variante existente con el stock cambiado va también `expectedStock` (control optimista en el
 * servidor); las combinaciones nuevas (talla/color añadidos) van con su stock y sin `expectedStock`.
 */
export function buildVariantsPayload(args: {
  editing: boolean;
  sizes: string;
  colors: string;
  sizesChanged: boolean;
  colorsChanged: boolean;
  /** Stock que escribe el admin, por clave `talla|color`. */
  stockByKey: Record<string, number>;
  /** Stock cargado al abrir el diálogo, por clave `talla|color` (vacío si el producto no tenía variantes). */
  originalStock: Record<string, number>;
  /** El admin ha escrito en algún campo de stock (aunque haya vuelto al valor original). */
  stockTouched: boolean;
}): VariantPayloadRow[] | undefined {
  const rows = expandVariantKeys(args.sizes, args.colors).flatMap((k): VariantPayloadRow[] => {
    const key = variantKey(k.size, k.color);
    const value = args.stockByKey[key] ?? 0;
    const original = args.originalStock[key];
    const row = { size: k.size || null, color: k.color || null, stock: value };
    if (!args.editing || original === undefined) return [row];
    return value === original ? [] : [{ ...row, expectedStock: original }];
  });
  const stockEdited = rows.some((r) => r.expectedStock !== undefined);
  const shouldSync =
    !args.editing || args.sizesChanged || args.colorsChanged || stockEdited || (args.stockTouched && rows.length > 0);
  return shouldSync ? rows : undefined;
}
