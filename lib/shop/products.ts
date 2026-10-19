import { prisma } from '@/lib/prisma';
import { withoutSeasonLink } from '@/lib/modules/season-link';
import { RESERVED_PRODUCT_SLUGS, toProductView, type ShopProductView } from '@/lib/shop/product-view';

/* Lectura de productos de la tienda para las páginas renderizadas en servidor (listado y ficha). Solo productos ACTIVOS, con sus variantes y sin
 * el vínculo a la temporada de Contabilidad (dato interno): lo mismo que ya expone `GET /api/products`. */

const include = {
  variants: { select: { id: true, size: true, color: true, stock: true }, orderBy: [{ size: 'asc' as const }, { color: 'asc' as const }] },
};

export async function getShopProducts(): Promise<ShopProductView[]> {
  const rows = await prisma.product.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' }, include });
  return withoutSeasonLink(rows).map(toProductView);
}

/** Un producto activo por su slug o, si el slug no sirve (vacío o reservado), por su id. null si no existe o está desactivado. */
export async function getShopProduct(param: string): Promise<ShopProductView | null> {
  const key = (param ?? '').trim();
  if (!key) return null;
  const row = RESERVED_PRODUCT_SLUGS.includes(key)
    ? null
    : await prisma.product.findFirst({ where: { isActive: true, OR: [{ slug: key }, { id: key }] }, include });
  return row ? toProductView(withoutSeasonLink(row)) : null;
}
