import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ArrowUpRight, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContactForm } from '@/components/contact-form';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/cine.css';
import type { HomeTemplateProps } from '../template-props';
import { ContentSections } from '../sections/content-sections';
import { titleSize, type TemplateEvent } from '../event-view';
import { CineRail, RailControls } from './event-card';
import { HeroMedia } from './hero-media';
import { CineTransitions } from './transitions';

/* Portada de la plantilla «cine»: la cabecera es un vídeo a pantalla completa con el nombre del próximo evento encima, y la cartelera va en un
 * riel horizontal de carteles. Es oscura por defecto (el cliente puede elegir otro modo). Todo el texto sale del cliente (marca, Configuración →
 * Contenido y Secciones); aquí no hay copy fijo de ninguna marca. El vídeo y el póster los sube el cliente en Apariencia; sin ellos, la cabecera
 * es un resplandor del color principal. */

export type HomeCineProps = HomeTemplateProps;

const rise = (i: number): CSSProperties => ({ ['--i' as string]: i });

export function CineHero({ brandName, hero, featured, media }: { brandName: string; hero: HomeCineProps['hero']; featured: TemplateEvent | null; media?: HomeCineProps['media'] }) {
  const headline = featured ? featured.name : hero.title || brandName;
  const eyebrow = featured ? `Próximo evento · ${featured.longDate}` : hero.badge || (headline === brandName ? '' : brandName);
  const video = media?.video ?? null;
  const poster = media?.poster ?? null;
  return (
    <section className="cn-hero" data-bare={!video && !poster}>
      <HeroMedia video={video} poster={poster} />
      <div className="mx-auto w-full max-w-[1600px] px-5 pb-12 pt-32 md:px-10 md:pb-20">
        {eyebrow && (
          <p className="cn-label cn-rise mb-5 !text-foreground/80 md:mb-8" style={rise(0)}>
            {eyebrow}
          </p>
        )}
        <h1 className="cn-title cn-rise md:max-w-[88%]" data-size={titleSize(headline)} style={rise(1)}>
          {headline}
        </h1>
        <div className="cn-rise mt-8 flex flex-wrap items-center gap-x-8 gap-y-4 md:mt-12" style={rise(2)}>
          {featured ? (
            <>
              <Button asChild size="lg" className="h-12 px-8 text-base font-semibold">
                <Link href={`/eventos/${featured.slug}/comprar`}>Comprar entradas</Link>
              </Button>
              <Link href={`/eventos/${featured.slug}`} className="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                Ver ficha <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
              {featured.place && <span className="text-sm text-muted-foreground">{featured.place}</span>}
              {featured.fromPrice != null && <span className="font-mono text-sm">desde {featured.fromPrice.toFixed(2)}€</span>}
              {featured.status && <span className="border border-current px-2 py-0.5 text-xs font-medium uppercase tracking-wide">{featured.status}</span>}
            </>
          ) : (
            <>
              {hero.subtitle && <p className="max-w-md text-lg text-muted-foreground">{hero.subtitle}</p>}
              {hero.primaryCta && (
                <Button asChild size="lg" className="h-12 px-8 text-base font-semibold">
                  <Link href={hero.primaryCta.href}>{hero.primaryCta.label}</Link>
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Bloque a todo el ancho que lleva a otra página (tienda, patrocinio). */
function LinkBlock({ href, title, text }: { href: string; title: string; text?: string }) {
  return (
    <Link href={href} className="block border-t border-border transition-colors duration-200 hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-6 px-5 py-10 md:px-10 md:py-14">
        <div className="min-w-0">
          <h2 className="cn-heading">{title}</h2>
          {text && <p className="mt-3 max-w-xl text-lg text-muted-foreground">{text}</p>}
        </div>
        <ArrowUpRight className="h-8 w-8 shrink-0 md:h-12 md:w-12" aria-hidden />
      </div>
    </Link>
  );
}

export function HomeCine(p: HomeCineProps) {
  const featured = p.events[0] ?? null;
  return (
    <>
      <CineTransitions />
      <CineHero brandName={p.brandName} hero={p.hero} featured={featured} media={p.media} />

      {p.hasEntradas && (
        <section id="cartelera" aria-labelledby="cartelera-titulo" className="py-12 md:py-20">
          <div className="mx-auto flex max-w-[1600px] items-end justify-between gap-4 px-5 pb-6 md:px-10 md:pb-10">
            <h2 id="cartelera-titulo" className="cn-heading">
              Cartelera
            </h2>
            <div className="flex items-center gap-6">
              {p.events.length > 0 && !p.loadError && (
                <Link href="/eventos" className="hidden items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline sm:inline-flex">
                  Ver todos <ArrowUpRight className="h-4 w-4" aria-hidden />
                </Link>
              )}
              {p.events.length > 1 && !p.loadError && <RailControls targetId="cartelera-riel" />}
            </div>
          </div>
          {p.loadError ? (
            <div role="alert" className="mx-5 border border-destructive/40 px-6 py-12 text-center md:mx-10">
              <WifiOff className="mx-auto mb-4 h-10 w-10 text-destructive/70" aria-hidden />
              <h3 className="cn-heading !text-2xl">No hemos podido cargar los eventos</h3>
              <p className="mx-auto mb-6 mt-2 max-w-md text-muted-foreground">Parece un fallo de conexión o del servidor: no es que no haya fechas publicadas.</p>
              <ReloadButton label="Reintentar" className="gap-2 font-medium" />
            </div>
          ) : p.events.length === 0 ? (
            <p className="mx-5 border-y border-border py-12 text-lg text-muted-foreground md:mx-10">Aún no hay eventos publicados. Vuelve pronto: la cartelera sale aquí primero.</p>
          ) : (
            <CineRail events={p.events} id="cartelera-riel" label="Cartelera de eventos" />
          )}
        </section>
      )}

      {p.hasTienda && <LinkBlock href="/tienda" title={p.copy.shopTitle || 'Tienda'} text={p.copy.shopSubtitle || `Lleva ${p.brandName} contigo.`} />}

      <ContentSections template="cine" sections={p.sections} slot="before-about" />

      {p.copy.aboutText && (
        <section id="sobre-nosotros" className="border-t border-border">
          <div className="mx-auto grid max-w-[1600px] gap-6 px-5 py-14 md:grid-cols-12 md:gap-x-8 md:px-10 md:py-24">
            <h2 className="cn-label md:col-span-3">{p.copy.aboutTitle || `Sobre ${p.brandName}`}</h2>
            <p className="font-display text-2xl font-medium leading-snug whitespace-pre-line md:col-span-8 md:text-4xl md:leading-[1.15]">{p.copy.aboutText}</p>
          </div>
        </section>
      )}

      <ContentSections template="cine" sections={p.sections} slot="after-about" />

      {p.hasSponsors && <LinkBlock href="/sponsors" title={p.copy.sponsorsTitle || '¿Quieres patrocinar nuestros eventos?'} text={p.copy.sponsorsSubtitle} />}

      {p.contactEnabled && (
        <section id="contacto" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto grid max-w-[1600px] gap-10 px-5 py-14 md:grid-cols-12 md:gap-x-8 md:px-10 md:py-24">
            <div className="md:col-span-4">
              <h2 className="cn-heading">Contacto</h2>
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
