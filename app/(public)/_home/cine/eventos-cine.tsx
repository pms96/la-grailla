import Link from 'next/link';
import '@/components/templates/cine.css';
import type { EventosTemplateProps } from '../template-props';
import { CineCard } from './event-card';
import { CineTransitions } from './transitions';

/** `/eventos` con la plantilla «cine»: la misma cartelera de la portada, pero en rejilla de carteles en vez de riel. */
export function EventosCine({ brandName, events }: EventosTemplateProps) {
  return (
    <div>
      <CineTransitions />
      <section>
        <div className="mx-auto max-w-[1600px] px-5 pb-8 pt-12 md:px-10 md:pb-14 md:pt-24">
          <p className="cn-label mb-5 md:mb-8">{brandName}</p>
          <h1 className="cn-title" data-size="m">
            Cartelera
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground">Elige fecha, compra online y llega con el QR listo.</p>
        </div>
      </section>

      <section className="mx-auto max-w-[1600px] px-5 pb-16 md:px-10 md:pb-24">
        {events.length === 0 ? (
          <div className="border-y border-border py-16">
            <h2 className="cn-heading">Todavía no hay fechas publicadas</h2>
            <p className="mt-3 max-w-md text-muted-foreground">Cuando salga la próxima, aparecerá aquí primero.</p>
            <Link href="/" className="mt-6 inline-block text-sm font-medium underline underline-offset-4">
              Volver al inicio
            </Link>
          </div>
        ) : (
          <>
            {/* Los nombres de las tarjetas son h3: sin este h2 (oculto) se saltaría un nivel bajo el h1. */}
            <h2 className="sr-only">Próximas fechas</h2>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-10 md:grid-cols-3 md:gap-x-6 lg:grid-cols-4">
              {events.map((e, i) => (
                <li key={e.id}>
                  <CineCard event={e} priority={i < 4} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
