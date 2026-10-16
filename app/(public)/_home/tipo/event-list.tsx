import Link from 'next/link';
import '@/components/templates/tipo.css';
import type { TemplateEvent } from '../event-view';
import { Composition } from './composition';

/**
 * Programa de la plantilla «tipo»: una fila por evento, con el día enorme, el nombre pesado y, en lugar de un cartel, una composición geométrica
 * propia de cada evento (sale de su slug, así que siempre es la misma). Componente de servidor, sin JavaScript en el navegador. Con puntero fino
 * la fila se tiñe del color de acento y la forma gira un cuarto de vuelta.
 */
export function EventList({ events }: { events: readonly TemplateEvent[] }) {
  return (
    <ul className="tp-list">
      {events.map((e) => (
        <li key={e.id}>
          <Link
            href={`/eventos/${e.slug}`}
            className="tp-row grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-5 md:grid-cols-[9rem_minmax(0,1fr)_13rem_7rem] md:gap-x-8 md:px-8 md:py-8"
          >
            <div>
              <span className="tp-day block text-4xl md:text-7xl">{e.day}</span>
              <span className="tp-label tp-muted mt-1 block">
                {e.weekday} {e.month}
              </span>
            </div>

            <div className="min-w-0">
              <h3 className="tp-name text-2xl sm:text-5xl lg:text-6xl">{e.name}</h3>
              {e.place && <p className="tp-muted mt-2 text-sm md:hidden">{e.place}</p>}
              {e.status && <p className="mt-2 inline-block border-2 border-current px-2 py-0.5 text-xs font-bold uppercase tracking-wide md:hidden">{e.status}</p>}
            </div>

            <div className="hidden md:block">
              {e.place && <p className="tp-muted text-base">{e.place}</p>}
              {e.fromPrice != null && <p className="mt-1 text-sm font-bold">desde {e.fromPrice.toFixed(2)}€</p>}
              {e.status && <p className="mt-2 inline-block border-2 border-current px-2 py-0.5 text-xs font-bold uppercase tracking-wide">{e.status}</p>}
            </div>

            <Composition seed={e.slug} n={3} palette={['primary', 'ink', 'accent']} className="tp-tile h-12 w-12 justify-self-end md:h-24 md:w-24" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
