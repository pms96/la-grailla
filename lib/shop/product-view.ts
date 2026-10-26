import { parseProductOptions } from '@/lib/shop-cart';
import { absoluteUrl, safeJsonLd } from '@/lib/seo/json-ld';

/* Vista pública de un producto de la tienda, ya lista para pintar (servidor y navegador): números, listas de tallas y colores, stock por variante
 * y la ruta de su ficha. Módulo PURO (sin Prisma ni React): lo usan las páginas de la tienda de la plantilla «drop», el carrito y los tests.
 *
 * El stock sigue la regla de siempre de la tienda: un producto SIN variantes no controla stock (se vende mientras esté activo); con variantes,
 * cada combinación talla/color tiene el suyo y una combinación que no existe cuenta como agotada. */

export type ProductVariantView = { size: string; color: string; stock: number };

export type ShopProductView = {
  id: string;
  slug: string;
  /** Ruta de la ficha (`/tienda/<slug>`, o `/tienda/<id>` si el slug no sirve). */
  path: string;
  name: string;
  description: string;
  price: number;
  imageUrl: string | null;
  /** Imágenes de la ficha: la principal primero y sin repetir. */
  images: string[];
  category: string | null;
  sizes: string[];
  colors: string[];
  variants: ProductVariantView[];
  /** ¿Queda algo a la venta? (sin variantes siempre; con variantes, si alguna tiene stock). */
  inStock: boolean;
};

/** Lo mínimo que se lee de un producto (compatible con la fila de Prisma ya con `price` como número). */
export type ProductInput = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  price: number;
  imageUrl?: string | null;
  images?: readonly string[] | null;
  category?: string | null;
  sizes?: string | null;
  colors?: string | null;
  variants?: readonly { size: string; color: string; stock: number }[] | null;
};

/** `/tienda/checkout` y `/tienda/confirmacion/…` ya existen: un producto con ese slug se abre por su id. */
export const RESERVED_PRODUCT_SLUGS: readonly string[] = ['checkout', 'confirmacion'];

export function productPath(p: { id: string; slug: string }): string {
  const slug = p.slug.trim();
  return slug && !RESERVED_PRODUCT_SLUGS.includes(slug) ? `/tienda/${slug}` : `/tienda/${p.id}`;
}

export function toProductView(p: ProductInput): ShopProductView {
  const variants = (p.variants ?? []).map((v) => ({ size: v.size, color: v.color, stock: v.stock }));
  const main = p.imageUrl ?? null;
  const images = [main, ...(p.images ?? [])].filter((u, i, all): u is string => !!u && all.indexOf(u) === i);
  return {
    id: p.id,
    slug: p.slug,
    path: productPath(p),
    name: p.name,
    description: (p.description ?? '').trim(),
    price: p.price,
    imageUrl: main ?? images[0] ?? null,
    images,
    category: p.category?.trim() || null,
    sizes: parseProductOptions(p.sizes),
    colors: parseProductOptions(p.colors),
    variants,
    inStock: variants.length === 0 || variants.some((v) => v.stock > 0),
  };
}

/** Stock de una combinación: `null` si el producto no controla stock; 0 si la combinación no existe. */
export function variantStock(product: Pick<ShopProductView, 'variants'>, size: string, color: string): number | null {
  if (product.variants.length === 0) return null;
  return product.variants.find((v) => v.size === size && v.color === color)?.stock ?? 0;
}

/** Categorías distintas en el orden en que aparecen (sin distinguir mayúsculas), para los filtros del listado. */
export function categoriesOf(products: readonly Pick<ShopProductView, 'category'>[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of products) {
    if (!p.category) continue;
    const key = p.category.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p.category);
  }
  return out;
}

/** Filtra por categoría (sin distinguir mayúsculas). Una categoría vacía o que no existe no filtra nada. */
export function filterByCategory<T extends Pick<ShopProductView, 'category'>>(products: readonly T[], category: string | null | undefined): T[] {
  const wanted = (category ?? '').trim().toLowerCase();
  if (!wanted || !products.some((p) => p.category?.toLowerCase() === wanted)) return [...products];
  return products.filter((p) => p.category?.toLowerCase() === wanted);
}

/** Quedan pocas unidades (para avisar al comprador): entre 1 y 5 en la combinación elegida. */
export function lowStockNote(stock: number | null): string | null {
  if (stock === null || stock <= 0 || stock > 5) return null;
  return stock === 1 ? 'Queda 1 unidad' : `Quedan ${stock} unidades`;
}

/** JSON-LD de un producto (Schema.org) para buscadores. `baseUrl` vacío = sin direcciones absolutas. */
export function productJsonLd(p: ShopProductView, brandName: string, baseUrl: string): Record<string, unknown> {
  const abs = (u: string) => absoluteUrl(u, baseUrl);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(p.images.length > 0 ? { image: p.images.map(abs) } : {}),
    ...(p.category ? { category: p.category } : {}),
    brand: { '@type': 'Brand', name: brandName },
    offers: {
      '@type': 'Offer',
      price: p.price.toFixed(2),
      priceCurrency: 'EUR',
      availability: p.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      ...(baseUrl ? { url: abs(p.path) } : {}),
    },
  };
}

// Vive en `lib/seo` (lo comparte la ficha de evento); se reexporta para no cambiar los imports de la tienda.
export { safeJsonLd };
