import Link from 'next/link';
import { WifiOff } from 'lucide-react';
import { Marquee } from '@/components/ui/marquee';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/marquesina.css';
import { EventRows } from './event-rows';
import type { EventosTemplateProps } from '../template-props';

/** `/eventos` con la plantilla «marquesina»: el mismo lenguaje que la portada (titular grande, cinta, filas con cartel flotante). */
export function EventosMarquesina({ brandName, events, loadError }: EventosTemplateProps) {
  return (
    <div>
      <section className="border-b border-border">
        <div className="mx-auto max-w-[1600px] px-4 pb-8 pt-8 md:px-8 md:pb-12 md:pt-14">
          <p className="mq-eyebrow mb-4 md:mb-6">{brandName}</p>
          <h1 className="mq-title" data-size="m">
            <span className="mq-word">
              <span>Programación</span>
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground">Elige fecha, compra online y llega con el QR listo.</p>
        </div>
        <div className="mq-band">
          <Marquee items={[brandName, 'Entradas online']} duration={36} />
        </div>
      </section>

      <section className="mx-auto max-w-[1600px] py-10 md:py-16">
        {loadError ? (
          <div role="alert" className="mx-4 border border-destructive/40 px-6 py-16 text-center md:mx-8">
            <WifiOff className="mx-auto mb-4 h-10 w-10 text-destructive/70" aria-hidden />
            <h2 className="font-display text-2xl uppercase">No hemos podido cargar la programación</h2>
            <p className="mx-auto mb-6 mt-2 max-w-md text-muted-foreground">Fallo de conexión o del servidor: no significa que no haya fechas. Prueba de nuevo.</p>
            <ReloadButton label="Reintentar" className="gap-2 font-semibold" />
          </div>
        ) : events.length === 0 ? (
          <div className="mx-4 border-y border-border py-16 md:mx-8">
            <h2 className="font-display text-3xl uppercase">Todavía no hay fechas publicadas</h2>
            <p className="mt-2 max-w-md text-muted-foreground">Cuando salga la próxima, aparecerá aquí primero.</p>
            <Link href="/" className="mt-6 inline-block text-sm font-medium underline underline-offset-4">
              Volver al inicio
            </Link>
          </div>
        ) : (
          <EventRows events={events} />
        )}
      </section>
    </div>
  );
}
