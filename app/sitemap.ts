import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/prisma';
import { getFallbackBaseUrl } from '@/lib/url';
import { isModuleEnabled } from '@/lib/modules/runtime';
import { getBrand } from '@/lib/brand/brand';
import { productPath } from '@/lib/shop/product-view';

// Dinámico: la base y los eventos dependen del cliente que pide el sitemap.
export const dynamic = 'force-dynamic';

// Modo normal: NEXTAUTH_URL o, si falta, el dominio de La Grailla (como siempre). Modo plataforma: el dominio del cliente.
const legacyBase = () => getFallbackBaseUrl() || 'https://www.lagrailla.es';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const BASE = legacyBase();
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, changeFrequency: 'daily', priority: 1 },
    // Solo las secciones de los módulos que el cliente tiene: antes se listaban todas y, sin el módulo, daban 404.
    ...(isModuleEnabled('entradas') ? [{ url: `${BASE}/eventos`, changeFrequency: 'daily' as const, priority: 0.9 }] : []),
    ...(isModuleEnabled('tienda') ? [{ url: `${BASE}/tienda`, changeFrequency: 'weekly' as const, priority: 0.7 }] : []),
    ...(isModuleEnabled('sponsors') ? [{ url: `${BASE}/sponsors`, changeFrequency: 'monthly' as const, priority: 0.5 }] : []),
    { url: `${BASE}/legal/aviso-legal`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${BASE}/legal/privacidad`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${BASE}/legal/cookies`, changeFrequency: 'yearly', priority: 0.2 },
  ];

  // Sin Entradas no se consultan ni se publican los eventos (aunque queden filas de antes en la BD del cliente).
  let eventRoutes: MetadataRoute.Sitemap = [];
  if (isModuleEnabled('entradas')) {
    try {
      const events = await prisma.event.findMany({
        where: { status: 'PUBLISHED' },
        select: { slug: true, updatedAt: true },
        orderBy: { date: 'asc' },
      });
      eventRoutes = events.map((e) => ({
        url: `${BASE}/eventos/${e.slug}`,
        lastModified: e.updatedAt,
        changeFrequency: 'daily',
        priority: 0.8,
      }));
    } catch {
      eventRoutes = [];
    }
  }

  // Las fichas de producto (`/tienda/<slug>`) solo se publican con la plantilla «drop», que es la que enlaza a ellas: en las demás la tienda
  // sigue siendo una sola página y no se anuncian URLs que el propio sitio no enseña. Y, como siempre, solo con el módulo Tienda.
  let productRoutes: MetadataRoute.Sitemap = [];
  if (isModuleEnabled('tienda')) {
    try {
      if ((await getBrand()).template === 'drop') {
        const products = await prisma.product.findMany({ where: { isActive: true }, select: { id: true, slug: true, updatedAt: true }, orderBy: { createdAt: 'desc' } });
        productRoutes = products.map((p) => ({ url: `${BASE}${productPath(p)}`, lastModified: p.updatedAt, changeFrequency: 'weekly', priority: 0.6 }));
      }
    } catch {
      productRoutes = [];
    }
  }

  return [...staticRoutes, ...eventRoutes, ...productRoutes];
}
