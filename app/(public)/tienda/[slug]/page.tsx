import { notFound } from 'next/navigation';
import { absoluteBrandUrl, getBrand } from '@/lib/brand/brand';
import { canonicalAlternates } from '@/lib/seo/canonical';
import { getFallbackBaseUrl } from '@/lib/url';
import { getActiveModules } from '@/lib/modules/runtime';
import { getShopProduct } from '@/lib/shop/products';
import { productJsonLd, type ShopProductView } from '@/lib/shop/product-view';
import { DropProductPage } from '../../_home/drop/product-page';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/drop.css';

// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

/** Producto activo de la URL, o null (no existe, está desactivado o el cliente no tiene Tienda). Un fallo de lectura se distingue de «no existe». */
async function load(slug: string): Promise<{ product: ShopProductView | null; failed: boolean }> {
  if (!getActiveModules().includes('tienda')) return { product: null, failed: false };
  try {
    return { product: await getShopProduct(slug), failed: false };
  } catch (error) {
    console.error('[ProductoPage] Error al cargar el producto:', error);
    return { product: null, failed: true };
  }
}

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const [{ product }, brand] = await Promise.all([load(params?.slug), getBrand()]);
  if (!product) return { title: 'Producto' };
  const description = product.description ? product.description.replace(/\s+/g, ' ').slice(0, 160) : `${product.name}, en la tienda de ${brand.name}.`;
  const image = product.imageUrl || absoluteBrandUrl(brand.ogImage);
  return {
    title: product.name,
    description,
    // Un mismo producto se abre por slug o por id: la canónica es siempre la ruta preferida (la del slug).
    ...canonicalAlternates(product.path),
    // El `openGraph` de una página sustituye al de la marca (no se mezclan): se completa aquí entero, con la foto del producto (o, si no tiene, la
    // imagen social de la marca) y Twitter con la misma.
    openGraph: { type: 'website', siteName: brand.name, locale: 'es_ES', title: product.name, description, ...(image ? { images: [{ url: image }] } : {}) },
    ...(image ? { twitter: { card: 'summary_large_image' as const, title: product.name, description, images: [image] } } : {}),
  };
}

export default async function ProductoPage({ params }: { params: { slug: string } }) {
  const { product, failed } = await load(params?.slug);
  // Un fallo de lectura no es lo mismo que «no existe»: se avisa y se deja reintentar (la aplicación no tiene pantalla de error propia).
  if (failed) {
    return (
      <div className="mx-auto max-w-[1400px] px-5 py-16 md:px-10">
        <div role="alert" className="rounded-lg border border-destructive/40 px-6 py-16 text-center">
          <h1 className="dp-heading !text-2xl">No hemos podido cargar el producto</h1>
          <p className="mx-auto mb-6 mt-2 max-w-md text-muted-foreground">Parece un fallo de conexión o del servidor: no es que el producto haya desaparecido.</p>
          <ReloadButton label="Reintentar" className="gap-2 font-semibold" />
        </div>
      </div>
    );
  }
  if (!product) notFound();
  const brand = await getBrand();
  return <DropProductPage product={product} jsonLd={productJsonLd(product, brand.name, getFallbackBaseUrl())} />;
}
