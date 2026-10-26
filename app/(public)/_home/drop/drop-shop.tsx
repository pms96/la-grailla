import Link from 'next/link';
import { Package } from 'lucide-react';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/drop.css';
import type { ShopProductView } from '@/lib/shop/product-view';
import { categoriesOf, filterByCategory } from '@/lib/shop/product-view';
import { titleSize } from '../event-view';
import { DropCart } from './drop-cart';
import { DropCard, toneAt } from './product-card';

/* `/tienda` con la plantilla «drop», renderizada en servidor: cabecera en bloque de color, filtros por categoría (son enlaces: `/tienda?categoria=…`,
 * así que se pueden compartir y funcionan sin JavaScript) y la rejilla de productos. Cada tarjeta lleva a su ficha. El texto de la cabecera es el
 * que el cliente escribió en Configuración → Contenido. */

export function DropShop({
  brandName,
  title,
  lead,
  products,
  category,
  loadError,
}: {
  brandName: string;
  title: string;
  lead: string;
  products: readonly ShopProductView[];
  /** Categoría pedida en la URL (puede no existir: entonces se enseña todo). */
  category?: string | null;
  loadError: boolean;
}) {
  const categories = categoriesOf(products);
  const shown = filterByCategory(products, category);
  const active = category && categories.some((c) => c.toLowerCase() === category.trim().toLowerCase()) ? category.trim().toLowerCase() : '';
  const stock = Object.fromEntries(products.map((p) => [p.id, p.variants]));

  return (
    <div>
      <section data-tone="primary">
        <div className="mx-auto max-w-[1400px] px-5 pb-10 pt-12 md:px-10 md:pb-16 md:pt-20">
          <p className="dp-label dp-rise mb-5 md:mb-8" style={{ ['--i' as string]: 0 }}>
            {brandName}
          </p>
          <h1 className="dp-title dp-rise" data-size={titleSize(title)} style={{ ['--i' as string]: 1 }}>
            {title}
          </h1>
          {lead && <p className="dp-rise mt-6 max-w-xl text-lg opacity-90" style={{ ['--i' as string]: 2 }}>{lead}</p>}
        </div>
      </section>

      <section className="mx-auto max-w-[1400px] px-5 pb-28 pt-8 md:px-10 md:pt-12">
        {loadError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 px-6 py-16 text-center">
            <Package className="mx-auto mb-4 h-10 w-10 text-destructive/70" aria-hidden />
            <h2 className="dp-heading !text-2xl">No hemos podido cargar la tienda</h2>
            <p className="mx-auto mb-6 mt-2 max-w-md text-muted-foreground">Parece un fallo de conexión o del servidor: no es que el catálogo esté vacío.</p>
            <ReloadButton label="Reintentar" className="gap-2 font-semibold" />
          </div>
        ) : products.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-6 py-20 text-center">
            <Package className="mx-auto mb-4 h-10 w-10 text-muted-foreground" aria-hidden />
            <h2 className="dp-heading !text-2xl">Catálogo en preparación</h2>
            <p className="mx-auto mt-2 max-w-md text-muted-foreground">Ahora mismo no hay productos a la venta. Vuelve pronto.</p>
          </div>
        ) : (
          <>
            {/* Los nombres de producto son h3: sin este h2 (oculto) se saltaría un nivel bajo el h1. */}
            <h2 className="sr-only">Productos</h2>
            {categories.length > 1 && (
              <nav aria-label="Categorías" className="mb-8 flex flex-wrap gap-2">
                <Link href="/tienda" className="dp-chip" aria-current={active === '' ? 'true' : undefined}>
                  Todo
                </Link>
                {categories.map((c) => (
                  <Link key={c} href={`/tienda?categoria=${encodeURIComponent(c)}`} className="dp-chip" aria-current={active === c.toLowerCase() ? 'true' : undefined}>
                    {c}
                  </Link>
                ))}
              </nav>
            )}
            <ul className="grid grid-cols-2 gap-x-4 gap-y-10 md:grid-cols-3 md:gap-x-6 lg:grid-cols-4">
              {shown.map((p, i) => (
                <li key={p.id}>
                  <DropCard product={p} tone={toneAt(i)} priority={i < 4} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <DropCart stock={stock} />
    </div>
  );
}
