import Link from 'next/link';
import '@/components/templates/galeria.css';
import type { EventosTemplateProps } from '../template-props';
import { EventEntries } from './event-entries';
import { GaleriaTitle } from './home-galeria';

/** `/eventos` con la plantilla «galería»: el mismo lenguaje que la portada (serifa grande, programa numerado con fotos que se revelan). */
export function EventosGaleria({ brandName, events, italicAccent = false }: EventosTemplateProps) {
  return (
    <div>
      <section className="mx-auto max-w-[1400px] px-5 pb-14 pt-10 md:px-10 md:pb-24 md:pt-20">
        <p className="gl-label mb-6 md:mb-10">{brandName}</p>
        <h1 className="gl-title" data-size="m">
          <GaleriaTitle text="Programa completo" italic={italicAccent} />
        </h1>
        <p className="mt-8 max-w-xl text-lg text-muted-foreground">Elige fecha, compra online y llega con el QR listo.</p>
      </section>

      <section className="mx-auto max-w-[1400px] pb-8">
        {events.length === 0 ? (
          <div className="mx-5 border-y border-border py-16 md:mx-10">
            <h2 className="gl-serif text-4xl">Todavía no hay fechas publicadas</h2>
            <p className="mt-3 max-w-md text-muted-foreground">Cuando salga la próxima, aparecerá aquí primero.</p>
            <Link href="/" className="mt-6 inline-block text-sm font-medium underline underline-offset-4">
              Volver al inicio
            </Link>
          </div>
        ) : (
          <EventEntries events={events} />
        )}
      </section>
    </div>
  );
}
