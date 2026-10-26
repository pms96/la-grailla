import '@/components/templates/cine.css';
import { blobImgProps, IMG_SIZES } from '@/lib/images/blob-image';
import type { TemplateEvent } from '../event-view';
import { RailControls } from './rail-controls';
import { posterTransitionName } from './transitions';

/* Tarjeta de evento de la plantilla «cine»: el cartel y, debajo, fecha, nombre, lugar y precio. Es un enlace normal (<a>, no el de Next) para que
 * el cartel pueda crecer hasta la ficha con una View Transition entre páginas (ver transitions.tsx). Todo está también en el texto. */

export function CineCard({ event: e, priority = false, sizes = IMG_SIZES.grid4 }: { event: TemplateEvent; priority?: boolean; sizes?: string }) {
  return (
    <a href={`/eventos/${e.slug}`} className="cn-card">
      <div className="cn-poster" style={{ ['viewTransitionName' as string]: posterTransitionName(e.slug) }}>
        {e.imageUrl ? (
          // img nativo: los carteles pueden ser subidas o URLs externas sin lista de dominios.
          // eslint-disable-next-line @next/next/no-img-element
          <img {...blobImgProps(e.imageUrl, { sizes })} alt="" loading={priority ? 'eager' : 'lazy'} decoding="async" />
        ) : (
          <div className="cn-poster-blank" aria-hidden>
            {e.name}
          </div>
        )}
        {e.status && <span className="cn-badge">{e.status}</span>}
      </div>
      <div className="mt-4">
        <p className="cn-label">
          {e.weekday} {e.day} {e.month}
        </p>
        <h3 className="cn-card-name mt-2">{e.name}</h3>
        {e.place && <p className="mt-1.5 text-sm text-muted-foreground">{e.place}</p>}
        {e.fromPrice != null && <p className="mt-1.5 font-mono text-sm">desde {e.fromPrice.toFixed(2)}€</p>}
      </div>
    </a>
  );
}

/** Cartelera en un riel horizontal con encaje. Es una región enfocable (se recorre con el teclado) y tiene flechas cuando hay JavaScript. */
export function CineRail({ events, id = 'cartelera', label }: { events: readonly TemplateEvent[]; id?: string; label: string }) {
  return (
    <div id={id} className="cn-rail" role="region" aria-label={label} tabIndex={0}>
      <ul className="cn-rail-list">
        {events.map((e, i) => (
          <li key={e.id} className="cn-rail-item">
            <CineCard event={e} priority={i < 2} sizes={IMG_SIZES.railCine} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export { RailControls };
