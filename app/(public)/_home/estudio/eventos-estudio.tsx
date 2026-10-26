import Link from 'next/link';
import { WifiOff } from 'lucide-react';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/estudio.css';
import { EventList } from './event-list';
import type { EventosTemplateProps } from '../template-props';

/** `/eventos` con la plantilla «estudio»: cabecera de frase corta y la agenda en filas, igual que en la portada. */
export function EventosEstudio({ brandName, events, loadError }: EventosTemplateProps) {
  return (
    <div>
      <section>
        <div className="mx-auto max-w-[1400px] px-5 pb-8 pt-12 md:px-10 md:pb-14 md:pt-24">
          <p className="es-label mb-6 md:mb-10">{brandName}</p>
          <h1 className="es-title" data-size="l">
            Agenda
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground">Elige fecha, compra online y llega con el QR listo.</p>
        </div>
      </section>

      <section className="mx-auto max-w-[1400px] px-5 pb-16 md:px-10 md:pb-24">
        {loadError ? (
          <div role="alert" className="border border-destructive/40 px-6 py-16 text-center">
            <WifiOff className="mx-auto mb-4 h-10 w-10 text-destructive/70" aria-hidden />
            <h2 className="es-heading !text-2xl">No hemos podido cargar la agenda</h2>
            <p className="mx-auto mb-6 mt-2 max-w-md text-muted-foreground">Fallo de conexión o del servidor: no significa que no haya fechas. Prueba de nuevo.</p>
            <ReloadButton label="Reintentar" className="gap-2 font-medium" />
          </div>
        ) : events.length === 0 ? (
          <div className="border-y border-border py-16">
            <h2 className="es-heading">Todavía no hay fechas publicadas</h2>
            <p className="mt-3 max-w-md text-muted-foreground">Cuando salga la próxima, aparecerá aquí primero.</p>
            <Link href="/" className="mt-6 inline-block text-sm font-medium underline underline-offset-4">
              Volver al inicio
            </Link>
          </div>
        ) : (
          <>
            {/* Los nombres de la agenda son h3: sin este h2 (oculto) se saltaría un nivel bajo el h1. */}
            <h2 className="sr-only">Próximas fechas</h2>
            <EventList events={events} />
          </>
        )}
      </section>
    </div>
  );
}
