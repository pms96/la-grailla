import Link from 'next/link';
import { blobImgProps, IMG_SIZES } from '@/lib/images/blob-image';
import '@/components/templates/drop.css';
import type { ShopProductView } from '@/lib/shop/product-view';
import { Tilt } from './tilt';

/* Tarjeta de producto de la plantilla «drop»: imagen sobre un bloque de color (alternan primario, acento y neutro), etiqueta de precio, y
 * debajo categoría y nombre. Es un enlace a la ficha del producto (`/tienda/<slug>`). */

export const TONES = ['primary', 'accent', 'muted'] as const;
export const toneAt = (i: number) => TONES[i % TONES.length]!;

export const priceLabel = (price: number) => `${price.toFixed(2)}€`;

export function DropCard({ product: p, tone, priority = false, sizes = IMG_SIZES.grid4 }: { product: ShopProductView; tone: string; priority?: boolean; sizes?: string }) {
  return (
    <Link href={p.path} className="dp-card">
      <Tilt className="dp-card-media" tone={tone}>
        {p.imageUrl ? (
          // img nativo: las imágenes de producto son subidas a Blob o URLs externas sin lista de dominios.
          // eslint-disable-next-line @next/next/no-img-element
          <img {...blobImgProps(p.imageUrl, { sizes })} alt="" loading={priority ? 'eager' : 'lazy'} decoding="async" />
        ) : (
          <span className="dp-noimg" aria-hidden>
            {p.name}
          </span>
        )}
        {!p.inStock && <span className="dp-badge">Agotado</span>}
        <span className="dp-tag">{priceLabel(p.price)}</span>
      </Tilt>
      <div className="mt-3">
        {p.category && <p className="dp-label mb-1">{p.category}</p>}
        <h3 className="dp-card-name">{p.name}</h3>
      </div>
    </Link>
  );
}
