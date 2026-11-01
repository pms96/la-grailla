import Link from 'next/link';
import '@/components/templates/drop.css';
import type { EventosTemplateProps } from '../template-props';
import { DropEvents } from './drop-events';

/** `/eventos` con la plantilla «drop»: cabecera en bloque de color y las mismas tarjetas de la portada. */
export function EventosDrop({ brandName, events }: EventosTemplateProps) {
  return (
    <div>
      <section data-tone="primary">
        <div className="mx-auto max-w-[1400px] px-5 pb-10 pt-12 md:px-10 md:pb-16 md:pt-20">
          <p className="dp-label mb-5 md:mb-8">{brandName}</p>
          <h1 className="dp-title" data-size="m">
            Eventos
          </h1>
          <p className="mt-6 max-w-xl text-lg opacity-90">Elige fecha, compra online y llega con el QR listo.</p>
        </div>
      </section>

      <section className="mx-auto max-w-[1400px] px-5 pb-16 pt-10 md:px-10 md:pb-24 md:pt-14">
        {events.length === 0 ? (
          <div className="border-y border-border py-16">
            <h2 className="dp-heading">Todavía no hay fechas publicadas</h2>
            <p className="mt-3 max-w-md text-muted-foreground">Cuando salga la próxima, aparecerá aquí primero.</p>
            <Link href="/" className="mt-6 inline-block text-sm font-medium underline underline-offset-4">
              Volver al inicio
            </Link>
          </div>
        ) : (
          <DropEvents events={events} />
        )}
      </section>
    </div>
  );
}
