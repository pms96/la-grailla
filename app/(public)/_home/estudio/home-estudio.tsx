import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ArrowUpRight, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContactForm } from '@/components/contact-form';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/estudio.css';
import type { HomeTemplateProps } from '../template-props';
import { ContentSections } from '../sections/content-sections';
import { EventList } from './event-list';

/* Portada de la plantilla «estudio», para empresas de servicios: un titular que cuenta qué hacéis, el índice de proyectos (lo primero que se
 * quiere ver), los servicios, quiénes sois y las dudas habituales. Si el cliente además tiene Entradas, Tienda o Sponsors, esos módulos
 * aparecen como bloques secundarios debajo. Todo el texto sale del cliente (marca, Configuración → Contenido y Secciones): aquí no hay copy
 * fijo de ninguna marca. */

export type HomeEstudioProps = HomeTemplateProps;

/** Tamaño del titular según su longitud: es una frase (no una palabra suelta), así que manda el total de letras. */
export function sentenceSize(text: string): 'l' | 'm' | 's' {
  const n = text.trim().length;
  return n <= 48 ? 'l' : n <= 96 ? 'm' : 's';
}

const rise = (i: number): CSSProperties => ({ ['--i' as string]: i });

export function EstudioHero({ brandName, hero }: { brandName: string; hero: HomeEstudioProps['hero'] }) {
  const headline = hero.title || brandName;
  const eyebrow = hero.badge || (headline === brandName ? '' : brandName);
  return (
    <section>
      <div className="mx-auto max-w-[1400px] px-5 pb-14 pt-12 md:px-10 md:pb-24 md:pt-24">
        {eyebrow && (
          <p className="es-label es-rise mb-6 md:mb-10" style={rise(0)}>
            {eyebrow}
          </p>
        )}
        <h1 className="es-title es-rise md:max-w-[94%]" data-size={sentenceSize(headline)} style={rise(1)}>
          {headline}
        </h1>
        {(hero.subtitle || hero.primaryCta) && (
          <div className="es-rise mt-10 grid gap-8 md:mt-16 md:grid-cols-12 md:items-end" style={rise(2)}>
            {hero.subtitle && <p className="max-w-md text-lg text-muted-foreground md:col-span-5">{hero.subtitle}</p>}
            {hero.primaryCta && (
              <div className="md:col-span-5 md:col-start-8 md:justify-self-end">
                <Button asChild size="lg" className="es-cta h-12 gap-2 px-7 text-base font-medium">
                  <Link href={hero.primaryCta.href}>
                    {hero.primaryCta.label} <ArrowUpRight className="es-arrow h-4 w-4" aria-hidden />
                  </Link>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Bloque a todo el ancho que lleva a otra página (tienda, patrocinio). */
function LinkBlock({ href, title, text }: { href: string; title: string; text?: string }) {
  return (
    <Link href={href} className="es-row border-t border-border focus-visible:outline-offset-[-2px]">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-6 px-5 py-10 md:px-10 md:py-14">
        <div className="min-w-0">
          <h2 className="es-heading">{title}</h2>
          {text && <p className="mt-3 max-w-xl text-lg text-muted-foreground">{text}</p>}
        </div>
        <ArrowUpRight className="h-8 w-8 shrink-0 md:h-12 md:w-12" aria-hidden />
      </div>
    </Link>
  );
}

export function HomeEstudio(p: HomeEstudioProps) {
  return (
    <>
      <EstudioHero brandName={p.brandName} hero={p.hero} />

      <ContentSections template="estudio" sections={p.sections} kinds={['proyectos', 'servicios']} />

      {p.copy.aboutText && (
        <section id="sobre-nosotros" className="border-t border-border">
          <div className="mx-auto grid max-w-[1400px] gap-6 px-5 py-14 md:grid-cols-12 md:gap-x-8 md:px-10 md:py-24">
            <h2 className="es-label md:col-span-3">{p.copy.aboutTitle || `Sobre ${p.brandName}`}</h2>
            <p className="font-display text-2xl font-medium leading-snug tracking-tight whitespace-pre-line md:col-span-8 md:text-4xl md:leading-[1.15]">{p.copy.aboutText}</p>
          </div>
        </section>
      )}

      <ContentSections template="estudio" sections={p.sections} kinds={['equipo', 'faq']} />

      {p.hasEntradas && (
        <section id="agenda" className="mx-auto max-w-[1400px] border-t border-border py-12 md:py-20">
          <div className="flex items-end justify-between gap-4 px-5 pb-6 md:px-10 md:pb-10">
            <h2 className="es-heading">Agenda</h2>
            {p.events.length > 0 && !p.loadError && (
              <Link href="/eventos" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                Ver todos <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
            )}
          </div>
          <div className="px-5 md:px-10">
            {p.loadError ? (
              <div role="alert" className="border border-destructive/40 px-6 py-12 text-center">
                <WifiOff className="mx-auto mb-4 h-10 w-10 text-destructive/70" aria-hidden />
                <h3 className="es-heading !text-2xl">No hemos podido cargar los eventos</h3>
                <p className="mx-auto mb-6 mt-2 max-w-md text-muted-foreground">Parece un fallo de conexión o del servidor: no es que no haya fechas publicadas.</p>
                <ReloadButton label="Reintentar" className="gap-2 font-medium" />
              </div>
            ) : p.events.length === 0 ? (
              <p className="border-y border-border py-12 text-lg text-muted-foreground">Aún no hay eventos publicados. Vuelve pronto.</p>
            ) : (
              <EventList events={p.events} />
            )}
          </div>
        </section>
      )}

      {p.hasTienda && <LinkBlock href="/tienda" title={p.copy.shopTitle || 'Tienda'} text={p.copy.shopSubtitle || `Lleva ${p.brandName} contigo.`} />}

      {p.hasSponsors && <LinkBlock href="/sponsors" title={p.copy.sponsorsTitle || '¿Quieres patrocinar nuestros eventos?'} text={p.copy.sponsorsSubtitle} />}

      {p.contactEnabled && (
        <section id="contacto" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto grid max-w-[1400px] gap-10 px-5 py-14 md:grid-cols-12 md:gap-x-8 md:px-10 md:py-24">
            <div className="md:col-span-4">
              <h2 className="es-heading">Contacto</h2>
              <p className="mt-3 text-muted-foreground">Cuéntanos qué necesitas y te respondemos por email.</p>
            </div>
            <div className="max-w-2xl md:col-span-7 md:col-start-6">
              <ContactForm />
            </div>
          </div>
        </section>
      )}
    </>
  );
}
