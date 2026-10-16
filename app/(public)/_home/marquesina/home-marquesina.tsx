import Link from 'next/link';
import { ArrowUpRight, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Marquee } from '@/components/ui/marquee';
import { ContactForm } from '@/components/contact-form';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/marquesina.css';
import type { HomeTemplateProps } from '../template-props';
import { ContentSections } from '../sections/content-sections';
import { EventRows } from './event-rows';
import { titleSize, type TemplateEvent } from '../event-view';

/* Portada de la plantilla «marquesina»: el nombre del evento ocupa la pantalla, una cinta lo acompaña con fecha · lugar · entradas y la
 * programación va en filas. El titular es lo único «enorme» de la página (el resto de títulos de sección son de un tamaño normal). Todo el
 * texto sale del cliente (marca y Configuración → Contenido); aquí no hay copy fijo de ninguna marca. */

export type HomeMarquesinaProps = HomeTemplateProps;

/** El titular partido en palabras: cada una sube desde su máscara (ver `.mq-word` en marquesina.css). El texto sigue siendo un único <h1>. */
export function Words({ text }: { text: string }) {
  const words = text.trim().split(/\s+/);
  return (
    <>
      {words.map((w, i) => (
        <span key={i}>
          <span className="mq-word" style={{ ['--i' as string]: i }}>
            <span>{w}</span>
          </span>
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  );
}

export function MarquesinaHero({ brandName, hero, featured }: { brandName: string; hero: HomeMarquesinaProps['hero']; featured: TemplateEvent | null }) {
  const headline = featured ? featured.name : hero.title || brandName;
  const eyebrow = featured ? `Próximo evento · ${featured.longDate}` : hero.badge || (headline === brandName ? '' : brandName);
  const bandItems = featured ? [featured.longDate, featured.place, 'Entradas'] : [brandName, hero.subtitle];
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-[1600px] px-4 pb-8 pt-8 md:px-8 md:pb-12 md:pt-14">
        {eyebrow && <p className="mq-eyebrow mb-4 md:mb-6">{eyebrow}</p>}
        <h1 className="mq-title" data-size={titleSize(headline)}>
          <Words text={headline} />
        </h1>

        <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4 md:mt-12">
          {featured ? (
            <>
              <Button asChild size="lg" className="h-12 px-8 text-base font-semibold">
                <Link href={`/eventos/${featured.slug}/comprar`}>Comprar entradas</Link>
              </Button>
              <Link href={`/eventos/${featured.slug}`} className="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                Ver ficha <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
              {featured.fromPrice != null && <span className="font-mono text-sm">desde {featured.fromPrice.toFixed(2)}€</span>}
              {featured.status && <span className="border border-current px-2 py-0.5 text-xs font-medium uppercase tracking-wide">{featured.status}</span>}
            </>
          ) : (
            hero.primaryCta && (
              <Button asChild size="lg" className="h-12 px-8 text-base font-semibold">
                <Link href={hero.primaryCta.href}>{hero.primaryCta.label}</Link>
              </Button>
            )
          )}
        </div>
      </div>
      <div className="mq-band">
        <Marquee items={bandItems} duration={36} />
      </div>
    </section>
  );
}

export function HomeMarquesina(p: HomeMarquesinaProps) {
  const featured = p.events[0] ?? null;
  return (
    <>
      <MarquesinaHero brandName={p.brandName} hero={p.hero} featured={featured} />

      {p.hasEntradas && (
        <section id="programacion" className="mx-auto max-w-[1600px] py-12 md:py-20">
          <div className="flex items-end justify-between gap-4 px-4 pb-6 md:px-8">
            <h2 className="font-display text-4xl uppercase leading-none md:text-6xl">Programación</h2>
            {p.events.length > 0 && !p.loadError && (
              <Link href="/eventos" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                Ver todos <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
            )}
          </div>
          {p.loadError ? (
            <div role="alert" className="mx-4 border border-destructive/40 px-6 py-12 text-center md:mx-8">
              <WifiOff className="mx-auto mb-4 h-10 w-10 text-destructive/70" aria-hidden />
              <h3 className="font-display text-2xl uppercase">No hemos podido cargar los eventos</h3>
              <p className="mx-auto mb-6 mt-2 max-w-md text-muted-foreground">Parece un fallo de conexión o del servidor: no es que no haya fechas publicadas.</p>
              <ReloadButton label="Reintentar" className="gap-2 font-semibold" />
            </div>
          ) : p.events.length === 0 ? (
            <p className="mx-4 border-y border-border py-12 text-lg text-muted-foreground md:mx-8">Aún no hay eventos publicados. Vuelve pronto: la programación sale aquí primero.</p>
          ) : (
            <EventRows events={p.events} />
          )}
        </section>
      )}

      {p.hasTienda && (
        <Link
          href="/tienda"
          className="mq-block mq-block-link block focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current"
        >
          <div className="mx-auto flex max-w-[1600px] items-end justify-between gap-6 px-4 py-10 md:px-8 md:py-16">
            <div className="min-w-0">
              <h2 className="font-display text-5xl uppercase leading-[0.9] md:text-7xl">{p.copy.shopTitle || 'Tienda'}</h2>
              <p className="mt-3 max-w-xl text-base opacity-90 md:text-lg">{p.copy.shopSubtitle || `Lleva ${p.brandName} contigo.`}</p>
            </div>
            <ArrowUpRight className="mq-block-arrow h-10 w-10 shrink-0 md:h-16 md:w-16" aria-hidden />
          </div>
        </Link>
      )}

      <ContentSections template="marquesina" sections={p.sections} slot="before-about" />

      {p.copy.aboutText && (
        <section id="sobre-nosotros" className="mx-auto grid max-w-[1600px] gap-6 px-4 py-14 md:grid-cols-12 md:gap-8 md:px-8 md:py-24">
          <h2 className="mq-eyebrow md:col-span-3">{p.copy.aboutTitle || `Sobre ${p.brandName}`}</h2>
          <p className="whitespace-pre-line text-2xl leading-snug md:col-span-9 md:text-4xl">{p.copy.aboutText}</p>
        </section>
      )}

      <ContentSections template="marquesina" sections={p.sections} slot="after-about" />

      {p.hasSponsors && (
        <Link
          href="/sponsors"
          className="mq-block-link block border-y border-border focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring"
        >
          <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-6 px-4 py-8 md:px-8 md:py-12">
            <div className="min-w-0">
              <h2 className="font-display text-3xl uppercase leading-none md:text-5xl">{p.copy.sponsorsTitle || '¿Quieres patrocinar nuestros eventos?'}</h2>
              {p.copy.sponsorsSubtitle && <p className="mt-3 max-w-xl text-muted-foreground">{p.copy.sponsorsSubtitle}</p>}
            </div>
            <ArrowUpRight className="mq-block-arrow h-8 w-8 shrink-0 md:h-12 md:w-12" aria-hidden />
          </div>
        </Link>
      )}

      {p.contactEnabled && (
        <section id="contacto" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto grid max-w-[1600px] gap-10 px-4 py-14 md:grid-cols-12 md:px-8 md:py-24">
            <div className="md:col-span-4">
              <h2 className="font-display text-4xl uppercase leading-none md:text-6xl">Contacto</h2>
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
