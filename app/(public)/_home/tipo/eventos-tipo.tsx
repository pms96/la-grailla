import Link from 'next/link';
import { WifiOff } from 'lucide-react';
import { Marquee } from '@/components/ui/marquee';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/tipo.css';
import type { EventosTemplateProps } from '../template-props';
import { Composition } from './composition';
import { EventList } from './event-list';
import { TipoWords } from './home-tipo';

/** `/eventos` con la plantilla «tipo»: el mismo lenguaje que la portada (bloque de color, titular pesado, cinta invertida y filas con filete grueso). */
export function EventosTipo({ brandName, events, loadError }: EventosTemplateProps) {
  return (
    <div>
      <section>
        <div className="tp-hero">
          <div className="mx-auto grid max-w-[1600px] items-end gap-10 px-4 pb-10 pt-10 md:grid-cols-12 md:gap-x-8 md:px-8 md:pb-16 md:pt-16">
            <div className="md:col-span-8">
              <p className="tp-label mb-5 opacity-80 md:mb-8">{brandName}</p>
              <h1 className="tp-title" data-size="m">
                <TipoWords text="Programa completo" />
              </h1>
              <p className="mt-6 max-w-xl text-lg opacity-90">Elige fecha, compra online y llega con el QR listo.</p>
            </div>
            <div className="md:col-span-4">
              <Composition seed={`${brandName} programa`} n={4} palette={['accent', 'onPrimary', 'ink']} className="block w-full max-w-[16rem] md:ml-auto md:max-w-none" />
            </div>
          </div>
        </div>
        <div className="tp-band">
          <Marquee items={[brandName, 'Entradas online']} duration={32} />
        </div>
      </section>

      <section className="mx-auto max-w-[1600px] py-10 md:py-16">
        {loadError ? (
          <div role="alert" className="mx-4 border-[3px] border-destructive px-6 py-14 text-center md:mx-8">
            <WifiOff className="mx-auto mb-4 h-10 w-10 text-destructive" aria-hidden />
            <h2 className="tp-heading text-3xl">No hemos podido cargar la programación</h2>
            <p className="mx-auto mb-6 mt-3 max-w-md text-muted-foreground">Fallo de conexión o del servidor: no significa que no haya fechas. Prueba de nuevo.</p>
            <ReloadButton label="Reintentar" className="gap-2 font-bold" />
          </div>
        ) : events.length === 0 ? (
          <div className="mx-4 border-y-[3px] border-foreground py-14 md:mx-8">
            <h2 className="tp-heading text-4xl">Todavía no hay fechas publicadas</h2>
            <p className="mt-3 max-w-md text-muted-foreground">Cuando salga la próxima, aparecerá aquí primero.</p>
            <Link href="/" className="mt-6 inline-block text-sm font-bold underline underline-offset-4">
              Volver al inicio
            </Link>
          </div>
        ) : (
          <EventList events={events} />
        )}
      </section>
    </div>
  );
}
