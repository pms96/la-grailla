import Link from 'next/link';
import { ArrowUpRight, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContactForm } from '@/components/contact-form';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/galeria.css';
import { titleSize, type TemplateEvent } from '../event-view';
import type { HomeTemplateProps } from '../template-props';
import { EventEntries } from './event-entries';

/* Portada de la plantilla «galería»: clara, con mucho aire y una serifa enorme. Una cabecera (nombre del evento, sus datos y la foto), el
 * programa numerado y, después, solo lo que el cliente tiene (tienda, texto propio, patrocinio, contacto). Todo el texto sale del cliente
 * (marca y Configuración → Contenido); aquí no hay copy fijo de ninguna marca. */

export type HomeGaleriaProps = HomeTemplateProps;

/** El titular; con una tipografía que tiene cursiva real, la última palabra va en cursiva. */
export function GaleriaTitle({ text, italic }: { text: string; italic: boolean }) {
  const words = text.trim().split(/\s+/);
  if (!italic || words.length < 2) return <>{text}</>;
  const last = words.pop() as string;
  return (
    <>
      {words.join(' ')} <em>{last}</em>
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-4 py-3">
      <dt className="gl-label pt-0.5">{label}</dt>
      <dd className="text-base">{children}</dd>
    </div>
  );
}

export function GaleriaHero({ brandName, hero, featured, italic = false }: { brandName: string; hero: HomeGaleriaProps['hero']; featured: TemplateEvent | null; italic?: boolean }) {
  const headline = featured ? featured.name : hero.title || brandName;
  const eyebrow = featured ? 'Próximo evento' : hero.badge || (headline === brandName ? '' : brandName);
  return (
    <section className="mx-auto max-w-[1400px] px-5 pb-16 pt-10 md:px-10 md:pb-28 md:pt-20">
      {eyebrow && <p className="gl-label mb-6 md:mb-10">{eyebrow}</p>}
      <h1 className="gl-title md:max-w-[92%]" data-size={titleSize(headline)}>
        <GaleriaTitle text={headline} italic={italic} />
      </h1>

      <div className="mt-12 grid gap-10 md:mt-20 md:grid-cols-12 md:gap-x-8">
        <div className="md:col-span-5 md:self-end">
          {featured ? (
            <>
              <dl className="divide-y divide-border border-y border-border">
                <Fact label="Fecha">
                  <span className="first-letter:uppercase">{featured.longDate}</span>
                </Fact>
                {featured.place && <Fact label="Lugar">{featured.place}</Fact>}
                {featured.fromPrice != null && <Fact label="Entradas">desde {featured.fromPrice.toFixed(2)}€</Fact>}
                {featured.status && <Fact label="Estado">{featured.status}</Fact>}
              </dl>
              <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4">
                <Button asChild size="lg" className="h-12 px-8 text-base font-medium">
                  <Link href={`/eventos/${featured.slug}/comprar`}>Comprar entradas</Link>
                </Button>
                <Link href={`/eventos/${featured.slug}`} className="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                  Ver ficha <ArrowUpRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            </>
          ) : (
            <>
              {hero.subtitle && <p className="max-w-md text-lg text-muted-foreground">{hero.subtitle}</p>}
              {hero.primaryCta && (
                <div className="mt-8">
                  <Button asChild size="lg" className="h-12 px-8 text-base font-medium">
                    <Link href={hero.primaryCta.href}>{hero.primaryCta.label}</Link>
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {featured && (
          <div className="md:col-span-6 md:col-start-7">
            {featured.imageUrl ? (
              <div className="gl-frame" data-hero>
                {/* img nativo: los carteles pueden ser subidas o URLs externas sin lista de dominios. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={featured.imageUrl} alt={`Cartel de ${featured.name}`} fetchPriority="high" />
              </div>
            ) : (
              <div className="gl-frame gl-frame--blank" aria-hidden>
                <span className="gl-numeral">{featured.day}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Una sección secundaria: la etiqueta a la izquierda y, a la derecha, un enlace grande en serifa. */
function LinkSection({ label, href, title, text, size }: { label: string; href: string; title: string; text?: string; size: 'l' | 'm' }) {
  return (
    <Link href={href} className="gl-entry block">
      <div className="mx-auto grid max-w-[1400px] gap-6 px-5 py-12 md:grid-cols-12 md:gap-x-8 md:px-10 md:py-20">
        <p className="gl-label md:col-span-3">{label}</p>
        <div className="flex items-end justify-between gap-6 md:col-span-9">
          <div className="min-w-0">
            <h2 className={size === 'l' ? 'gl-serif text-5xl md:text-7xl' : 'gl-serif text-4xl md:text-5xl'}>
              <span className="gl-underline">{title}</span>
            </h2>
            {text && <p className="mt-4 max-w-xl text-lg text-muted-foreground">{text}</p>}
          </div>
          <ArrowUpRight className="h-8 w-8 shrink-0 md:h-12 md:w-12" aria-hidden />
        </div>
      </div>
    </Link>
  );
}

export function HomeGaleria(p: HomeGaleriaProps) {
  const featured = p.events[0] ?? null;
  return (
    <>
      <GaleriaHero brandName={p.brandName} hero={p.hero} featured={featured} italic={p.italicAccent} />

      {p.hasEntradas && (
        <section id="programa" className="mx-auto max-w-[1400px]">
          <div className="flex items-end justify-between gap-4 px-5 pb-8 md:px-10 md:pb-12">
            <h2 className="gl-serif text-5xl md:text-7xl">Programa</h2>
            {p.events.length > 0 && !p.loadError && (
              <Link href="/eventos" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                Ver todos <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
            )}
          </div>
          {p.loadError ? (
            <div role="alert" className="mx-5 border border-destructive/40 px-6 py-14 text-center md:mx-10">
              <WifiOff className="mx-auto mb-4 h-10 w-10 text-destructive/70" aria-hidden />
              <h3 className="gl-serif text-3xl">No hemos podido cargar los eventos</h3>
              <p className="mx-auto mb-6 mt-3 max-w-md text-muted-foreground">Parece un fallo de conexión o del servidor: no es que no haya fechas publicadas.</p>
              <ReloadButton label="Reintentar" className="gap-2 font-medium" />
            </div>
          ) : p.events.length === 0 ? (
            <p className="mx-5 border-y border-border py-14 text-lg text-muted-foreground md:mx-10">Aún no hay eventos publicados. Vuelve pronto: el programa sale aquí primero.</p>
          ) : (
            <EventEntries events={p.events} />
          )}
        </section>
      )}

      {p.hasTienda && <LinkSection label="Tienda" href="/tienda" title={p.copy.shopTitle || 'Tienda'} text={p.copy.shopSubtitle || `Lleva ${p.brandName} contigo.`} size="l" />}

      {p.copy.aboutText && (
        <section id="sobre-nosotros" className="border-t border-border">
          <div className="mx-auto grid max-w-[1400px] gap-6 px-5 py-14 md:grid-cols-12 md:gap-x-8 md:px-10 md:py-28">
            <h2 className="gl-label md:col-span-3">{p.copy.aboutTitle || `Sobre ${p.brandName}`}</h2>
            <p className="gl-serif whitespace-pre-line text-3xl leading-[1.15] md:col-span-9 md:text-5xl md:leading-[1.12]">{p.copy.aboutText}</p>
          </div>
        </section>
      )}

      {p.hasSponsors && (
        <LinkSection label="Marcas" href="/sponsors" title={p.copy.sponsorsTitle || '¿Quieres patrocinar nuestros eventos?'} text={p.copy.sponsorsSubtitle} size="m" />
      )}

      {p.contactEnabled && (
        <section id="contacto" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto grid max-w-[1400px] gap-10 px-5 py-14 md:grid-cols-12 md:gap-x-8 md:px-10 md:py-28">
            <div className="md:col-span-4">
              <h2 className="gl-serif text-5xl md:text-7xl">Contacto</h2>
              <p className="mt-4 text-muted-foreground">Cuéntanos qué necesitas y te respondemos por email.</p>
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
