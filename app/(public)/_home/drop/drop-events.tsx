import Link from 'next/link';
import '@/components/templates/drop.css';
import type { TemplateEvent } from '../event-view';
import { toneAt } from './product-card';

/** Eventos de la plantilla «drop»: una tarjeta de color por evento con el día grande, el nombre, el lugar y el precio. Todo está en el texto. */
export function DropEvents({ events }: { events: readonly TemplateEvent[] }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {events.map((e, i) => (
        <li key={e.id}>
          <Link href={`/eventos/${e.slug}`} data-tone={toneAt(i)} className="flex min-h-[15rem] flex-col justify-between rounded-lg p-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            <div className="flex items-start justify-between gap-3">
              <p className="font-display text-6xl font-bold leading-none tracking-tight">{e.day}</p>
              <p className="dp-label text-right">
                {e.weekday}
                <br />
                {e.month}
              </p>
            </div>
            <div>
              <h3 className="dp-card-name !text-2xl">{e.name}</h3>
              {e.place && <p className="mt-1.5 text-sm opacity-85">{e.place}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {e.fromPrice != null && <span className="font-mono text-sm">desde {e.fromPrice.toFixed(2)}€</span>}
                {e.status && <span className="border border-current px-2 py-0.5 text-xs font-bold uppercase tracking-wide">{e.status}</span>}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
