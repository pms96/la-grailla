import Link from 'next/link';
import { blobImgProps, IMG_SIZES } from '@/lib/images/blob-image';
import { ArrowLeft } from 'lucide-react';
import '@/components/templates/drop.css';
import { safeJsonLd, type ShopProductView } from '@/lib/shop/product-view';
import { DropCart } from './drop-cart';
import { ProductBuy } from './product-buy';

/* Ficha de un producto (`/tienda/<slug>`): las imágenes en una tira con encaje (se recorre con el dedo, el ratón o el teclado, sin JavaScript),
 * y a la derecha el nombre, el precio, la descripción y la compra. Está hecha solo con tokens, así que se ve bien con cualquier plantilla. */

export function DropProductPage({ product: p, jsonLd }: { product: ShopProductView; jsonLd: Record<string, unknown> }) {
  return (
    <article className="mx-auto max-w-[1400px] px-5 pb-28 pt-8 md:px-10 md:pt-12">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
      <Link href="/tienda" className="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Tienda
      </Link>

      <div className="mt-6 grid gap-8 md:grid-cols-12 md:gap-x-12">
        <div className="md:col-span-7">
          {p.images.length > 0 ? (
            // La propia lista es la región desplazable: enfocable cuando hay más de una imagen, para recorrerla con el teclado.
            <ul className="dp-strip" aria-label={`Imágenes de ${p.name}`} tabIndex={p.images.length > 1 ? 0 : undefined}>
              {p.images.map((src, i) => (
                <li key={src}>
                  <div className="dp-strip-media" data-tone="muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img {...blobImgProps(src, { sizes: IMG_SIZES.productStrip })} alt={i === 0 ? p.name : `${p.name}, imagen ${i + 1}`} loading={i === 0 ? 'eager' : 'lazy'} decoding="async" fetchPriority={i === 0 ? 'high' : undefined} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="dp-strip-media" data-tone="primary">
              <span className="dp-noimg" aria-hidden>
                {p.name}
              </span>
            </div>
          )}
        </div>

        <div className="md:sticky md:top-24 md:col-span-5 md:self-start">
          {p.category && <p className="dp-label mb-3">{p.category}</p>}
          <h1 className="dp-heading">{p.name}</h1>
          <p className="mt-5">
            <span className="dp-tag dp-tag-lg">{p.price.toFixed(2)}€</span>
          </p>
          {p.description && <p className="mt-6 whitespace-pre-line text-lg text-muted-foreground">{p.description}</p>}
          <div className="mt-8">
            <ProductBuy product={p} />
          </div>
        </div>
      </div>

      <DropCart stock={{ [p.id]: p.variants }} />
    </article>
  );
}
