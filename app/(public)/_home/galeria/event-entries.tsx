import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import '@/components/templates/galeria.css';
import { cn } from '@/lib/utils';
import type { TemplateEvent } from '../event-view';

/**
 * Programa de la plantilla «galería»: una entrada por evento, numerada en el orden del calendario (la numeración dice algo real: cuál viene
 * antes). Componente de servidor, sin JavaScript en el navegador: la foto se revela y se desplaza con CSS ligado al scroll (ver galeria.css).
 * Las entradas pares invierten el lado de la foto para dar ritmo.
 */
export function EventEntries({ events }: { events: readonly TemplateEvent[] }) {
  return (
    <ol className="gl-list">
      {events.map((e, i) => {
        const flip = i % 2 === 1;
        return (
          <li key={e.id}>
            <Link
              href={`/eventos/${e.slug}`}
              className="gl-entry grid gap-x-8 gap-y-6 px-5 py-12 md:grid-cols-12 md:px-10 md:py-20"
            >
              <p className="gl-label gl-num md:col-span-1 md:col-start-1 md:row-start-1">N.º {String(i + 1).padStart(2, '0')}</p>

              <div
                className={cn(
                  'order-2 md:order-none md:row-start-1',
                  flip ? 'md:col-span-4 md:col-start-2' : 'md:col-span-4 md:col-start-9'
                )}
              >
                {e.imageUrl ? (
                  <div className="gl-frame" data-reveal>
                    {/* img nativo: los carteles pueden ser subidas o URLs externas sin lista de dominios. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={e.imageUrl} alt="" loading="lazy" />
                  </div>
                ) : (
                  <div className="gl-frame gl-frame--blank" data-reveal aria-hidden>
                    <span className="gl-numeral">{e.day}</span>
                  </div>
                )}
              </div>

              <div className={cn('order-3 md:order-none md:row-start-1 md:self-center', flip ? 'md:col-span-7 md:col-start-6' : 'md:col-span-6 md:col-start-2')}>
                <p className="gl-label mb-4">{e.longDate}</p>
                <h3 className="gl-serif text-4xl md:text-6xl">
                  <span className="gl-underline">{e.name}</span>
                </h3>
                {e.place && <p className="mt-4 text-lg text-muted-foreground">{e.place}</p>}
                <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                  {e.fromPrice != null && <span className="gl-num">desde {e.fromPrice.toFixed(2)}€</span>}
                  {e.status && <span className="border border-current px-2 py-0.5 text-xs font-medium uppercase tracking-wide">{e.status}</span>}
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    Ver ficha <ArrowUpRight className="h-4 w-4" aria-hidden />
                  </span>
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
