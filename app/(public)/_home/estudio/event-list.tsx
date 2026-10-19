import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import '@/components/templates/estudio.css';
import type { TemplateEvent } from '../event-view';

/** Agenda de la plantilla «estudio»: una fila por evento, con el mismo lenguaje que el índice de proyectos (sin imagen flotante: aquí lo
 *  importante es la fecha, el lugar y el estado de la venta). Todo está en el texto. */
export function EventList({ events }: { events: readonly TemplateEvent[] }) {
  return (
    <ul className="es-list">
      {events.map((e) => (
        <li key={e.id}>
          <Link href={`/eventos/${e.slug}`} className="es-row">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-6 md:grid-cols-[7rem_minmax(0,1fr)_15rem_2rem] md:gap-x-8 md:py-8">
              <p className="hidden font-mono text-xs uppercase tracking-wider text-muted-foreground md:block">
                {e.weekday} {e.day} {e.month}
              </p>
              <div className="min-w-0">
                <h3 className="es-row-title es-row-title-sm">{e.name}</h3>
                <p className="mt-2 font-mono text-xs uppercase tracking-wider text-muted-foreground md:hidden">
                  {e.weekday} {e.day} {e.month}
                  {e.place ? ` · ${e.place}` : ''}
                </p>
              </div>
              <div className="hidden md:block">
                {e.place && <p className="text-muted-foreground">{e.place}</p>}
                {e.fromPrice != null && <p className="mt-1 font-mono text-sm">desde {e.fromPrice.toFixed(2)}€</p>}
                {e.status && <p className="mt-2 inline-block border border-current px-2 py-0.5 text-xs font-medium uppercase tracking-wide">{e.status}</p>}
              </div>
              <ArrowUpRight className="h-5 w-5 justify-self-end md:h-6 md:w-6" aria-hidden />
              {e.status && (
                <p className="col-span-2 mt-2 inline-block w-fit border border-current px-2 py-0.5 text-xs font-medium uppercase tracking-wide md:hidden">{e.status}</p>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
