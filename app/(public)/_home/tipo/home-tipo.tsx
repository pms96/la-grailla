import Link from 'next/link';
import { ArrowUpRight, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Marquee } from '@/components/ui/marquee';
import { ContactForm } from '@/components/contact-form';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/tipo.css';
import { titleSize, type TemplateEvent } from '../event-view';
import type { HomeTemplateProps } from '../template-props';
import { ContentSections } from '../sections/content-sections';
import { Composition } from './composition';
import { EventList } from './event-list';

/* Portada de la plantilla «tipo», para quien no tiene fotos: un bloque de color con un titular enorme y una composición geométrica generada
 * (en lugar de una imagen), una cinta invertida, el programa en filas con filetes gruesos y bloques de color para lo demás. Todo el texto sale
 * del cliente (marca y Configuración → Contenido); aquí no hay copy fijo de ninguna marca. */

export type HomeTipoProps = HomeTemplateProps;

/** El titular partido en palabras: cada una sube desde su máscara (ver `.tp-word` en tipo.css). El texto sigue siendo un único <h1>. */
export function TipoWords({ text }: { text: string }) {
  const words = text.trim().split(/\s+/);
  return (
    <>
      {words.map((w, i) => (
        <span key={i}>
          <span className="tp-word" style={{ ['--i' as string]: i }}>
            <span>{w}</span>
          </span>
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  );
}

export function TipoHero({ brandName, hero, featured }: { brandName: string; hero: HomeTipoProps['hero']; featured: TemplateEvent | null }) {
  const headline = featured ? featured.name : hero.title || brandName;
  const eyebrow = featured ? `Próximo evento · ${featured.longDate}` : hero.badge || (headline === brandName ? '' : brandName);
  const bandItems = featured ? [featured.longDate, featured.place, 'Entradas'] : [brandName, hero.subtitle];
  const cta = 'h-12 bg-accent px-8 text-base font-bold text-accent-foreground hover:bg-accent/90';
  return (
    <section>
      <div className="tp-hero">
        <div className="mx-auto grid max-w-[1600px] items-end gap-10 px-4 pb-10 pt-10 md:grid-cols-12 md:gap-x-8 md:px-8 md:pb-16 md:pt-16">
          <div className="md:col-span-8">
            {eyebrow && <p className="tp-label mb-5 opacity-80 md:mb-8">{eyebrow}</p>}
            <h1 className="tp-title" data-size={titleSize(headline, true)}>
              <TipoWords text={headline} />
            </h1>

            <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4 md:mt-12">
              {featured ? (
                <>
                  <Button asChild size="lg" className={cta}>
                    <Link href={`/eventos/${featured.slug}/comprar`}>Comprar entradas</Link>
                  </Button>
                  <Link href={`/eventos/${featured.slug}`} className="inline-flex items-center gap-1.5 text-sm font-bold underline-offset-4 hover:underline">
                    Ver ficha <ArrowUpRight className="h-4 w-4" aria-hidden />
                  </Link>
                  {featured.fromPrice != null && <span className="text-sm font-bold">desde {featured.fromPrice.toFixed(2)}€</span>}
                  {featured.status && <span className="border-2 border-current px-2 py-0.5 text-xs font-bold uppercase tracking-wide">{featured.status}</span>}
                </>
              ) : (
                hero.primaryCta && (
                  <Button asChild size="lg" className={cta}>
                    <Link href={hero.primaryCta.href}>{hero.primaryCta.label}</Link>
                  </Button>
                )
              )}
            </div>
          </div>

          <div className="md:col-span-4">
            <Composition seed={headline} n={4} palette={['accent', 'onPrimary', 'ink']} className="block w-full max-w-[16rem] md:ml-auto md:max-w-none" />
          </div>
        </div>
      </div>
      <div className="tp-band">
        <Marquee items={bandItems} duration={32} />
      </div>
    </section>
  );
}

/** Una sección que es un enlace grande con un bloque de color de fondo. */
function BlockLink({ href, title, text, tone }: { href: string; title: string; text?: string; tone: 'accent' | 'line' }) {
  return (
    <Link
      href={href}
      className={
        tone === 'accent'
          ? 'tp-accent tp-link block focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-4 focus-visible:outline-current'
          : 'tp-link block border-y-[3px] border-foreground focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-4 focus-visible:outline-ring'
      }
    >
      <div className="mx-auto flex max-w-[1600px] items-end justify-between gap-6 px-4 py-10 md:px-8 md:py-16">
        <div className="min-w-0">
          <h2 className={tone === 'accent' ? 'tp-heading text-5xl md:text-8xl' : 'tp-heading text-3xl md:text-6xl'}>{title}</h2>
          {text && <p className={tone === 'accent' ? 'mt-3 max-w-xl text-base opacity-90 md:text-lg' : 'tp-muted mt-3 max-w-xl text-base md:text-lg'}>{text}</p>}
        </div>
        <ArrowUpRight className="tp-arrow h-10 w-10 shrink-0 md:h-16 md:w-16" aria-hidden />
      </div>
    </Link>
  );
}

export function HomeTipo(p: HomeTipoProps) {
  const featured = p.events[0] ?? null;
  return (
    <>
      <TipoHero brandName={p.brandName} hero={p.hero} featured={featured} />

      {p.hasEntradas && (
        <section id="programa" className="mx-auto max-w-[1600px] py-12 md:py-20">
          <div className="flex items-end justify-between gap-4 px-4 pb-6 md:px-8 md:pb-10">
            <h2 className="tp-heading text-5xl md:text-7xl">Programa</h2>
            {p.events.length > 0 && !p.loadError && (
              <Link href="/eventos" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-bold underline-offset-4 hover:underline">
                Ver todos <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
            )}
          </div>
          {p.loadError ? (
            <div role="alert" className="mx-4 border-[3px] border-destructive px-6 py-12 text-center md:mx-8">
              <WifiOff className="mx-auto mb-4 h-10 w-10 text-destructive" aria-hidden />
              <h3 className="tp-heading text-3xl">No hemos podido cargar los eventos</h3>
              <p className="mx-auto mb-6 mt-3 max-w-md text-muted-foreground">Parece un fallo de conexión o del servidor: no es que no haya fechas publicadas.</p>
              <ReloadButton label="Reintentar" className="gap-2 font-bold" />
            </div>
          ) : p.events.length === 0 ? (
            <p className="mx-4 border-y-[3px] border-foreground py-12 text-lg text-muted-foreground md:mx-8">Aún no hay eventos publicados. Vuelve pronto: el programa sale aquí primero.</p>
          ) : (
            <EventList events={p.events} />
          )}
        </section>
      )}

      {p.hasTienda && <BlockLink href="/tienda" title={p.copy.shopTitle || 'Tienda'} text={p.copy.shopSubtitle || `Lleva ${p.brandName} contigo.`} tone="accent" />}

      <ContentSections template="tipo" sections={p.sections} slot="before-about" />

      {p.copy.aboutText && (
        <section id="sobre-nosotros" className="mx-auto grid max-w-[1600px] gap-6 px-4 py-14 md:grid-cols-12 md:gap-8 md:px-8 md:py-24">
          <h2 className="tp-label md:col-span-3">{p.copy.aboutTitle || `Sobre ${p.brandName}`}</h2>
          <p className="tp-heading whitespace-pre-line text-3xl leading-[1.12] md:col-span-9 md:text-5xl md:leading-[1.1]">{p.copy.aboutText}</p>
        </section>
      )}

      <ContentSections template="tipo" sections={p.sections} slot="after-about" />

      {p.hasSponsors && <BlockLink href="/sponsors" title={p.copy.sponsorsTitle || '¿Quieres patrocinar nuestros eventos?'} text={p.copy.sponsorsSubtitle} tone="line" />}

      {p.contactEnabled && (
        <section id="contacto" className="scroll-mt-20">
          <div className="mx-auto grid max-w-[1600px] gap-10 px-4 py-14 md:grid-cols-12 md:px-8 md:py-24">
            <div className="md:col-span-4">
              <h2 className="tp-heading text-5xl md:text-7xl">Contacto</h2>
              <p className="mt-3 text-muted-foreground">Cuéntanos qué necesitas y te respondemos por email.</p>
            </div>
            <div className="max-w-2xl md:col-span-8">
              <ContactForm />
            </div>
          </div>
        </section>
      )}
    </>
  );
}
