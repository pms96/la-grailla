import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ArrowUpRight, WifiOff } from 'lucide-react';
import { ContactForm } from '@/components/contact-form';
import { ReloadButton } from '@/components/reload-button';
import '@/components/templates/drop.css';
import type { ShopProductView } from '@/lib/shop/product-view';
import type { HomeTemplateProps } from '../template-props';
import { ContentSections } from '../sections/content-sections';
import { titleSize } from '../event-view';
import { DropCart } from './drop-cart';
import { DropEvents } from './drop-events';
import { DropCard, priceLabel, toneAt } from './product-card';
import { Tilt } from './tilt';

/* Portada de la plantilla «drop», para comercio y marca: un bloque de color con el titular y el producto destacado (grande, con su etiqueta de
 * precio y siguiendo al cursor), el riel de novedades con encaje y, debajo, lo demás que el cliente tenga (servicios, equipo, preguntas, eventos,
 * patrocinio y contacto). Todo el texto sale del cliente: aquí no hay copy fijo de ninguna marca. */

export type HomeDropProps = HomeTemplateProps;

/** Cuántos productos caben en el riel de la portada (el resto está en /tienda). */
const RAIL_MAX = 10;

const rise = (i: number): CSSProperties => ({ ['--i' as string]: i });

export function DropHero({ brandName, hero, hasTienda, featured }: { brandName: string; hero: HomeDropProps['hero']; hasTienda: boolean; featured: ShopProductView | null }) {
  const headline = hero.title || brandName;
  const eyebrow = hero.badge || (headline === brandName ? '' : brandName);
  // Con tienda, el botón lleva a ella; sin tienda, el de siempre (eventos o contacto).
  const cta = hasTienda ? { href: '/tienda', label: 'Ir a la tienda' } : hero.primaryCta ? { href: hero.primaryCta.href, label: hero.primaryCta.label } : null;
  return (
    <section data-tone="primary" className="overflow-hidden">
      <div className="mx-auto grid max-w-[1400px] items-center gap-10 px-5 py-12 md:grid-cols-12 md:gap-x-10 md:px-10 md:py-20">
        <div className={featured ? 'md:col-span-7' : 'md:col-span-10'}>
          {eyebrow && (
            <p className="dp-label dp-rise mb-5 md:mb-8" style={rise(0)}>
              {eyebrow}
            </p>
          )}
          <h1 className="dp-title dp-rise" data-size={titleSize(headline)} style={rise(1)}>
            {headline}
          </h1>
          {hero.subtitle && (
            <p className="dp-rise mt-6 max-w-xl text-lg opacity-90" style={rise(2)}>
              {hero.subtitle}
            </p>
          )}
          {cta && (
            <div className="dp-rise mt-8 md:mt-10" style={rise(3)}>
              <Link href={cta.href} className="dp-btn">
                {cta.label} <ArrowUpRight className="h-5 w-5" aria-hidden />
              </Link>
            </div>
          )}
        </div>

        {featured && (
          <div className="dp-rise md:col-span-5" style={rise(2)}>
            {/* Sin aria-label: el nombre accesible sale del texto visible (precio y nombre), como exige «etiqueta en el nombre». */}
            <Link href={featured.path} className="dp-card">
              <Tilt className="dp-card-media" tone="accent">
                {featured.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={featured.imageUrl} alt="" loading="eager" decoding="async" fetchPriority="high" />
                ) : (
                  <span className="dp-noimg" aria-hidden>
                    {featured.name}
                  </span>
                )}
                {!featured.inStock && <span className="dp-badge">Agotado</span>}
                <span className="dp-tag dp-tag-lg">{priceLabel(featured.price)}</span>
              </Tilt>
              <p className="dp-card-name mt-3 !text-2xl">{featured.name}</p>
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}

/** Bloque a todo el ancho que lleva a otra página (patrocinio). */
function LinkBlock({ href, title, text }: { href: string; title: string; text?: string }) {
  return (
    <Link href={href} data-tone="ink" className="block focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-6 px-5 py-10 md:px-10 md:py-14">
        <div className="min-w-0">
          <h2 className="dp-heading">{title}</h2>
          {text && <p className="mt-3 max-w-xl text-lg opacity-85">{text}</p>}
        </div>
        <ArrowUpRight className="h-8 w-8 shrink-0 md:h-12 md:w-12" aria-hidden />
      </div>
    </Link>
  );
}

export function HomeDrop(p: HomeDropProps) {
  const products = p.hasTienda ? (p.products ?? []) : [];
  const featured = products.find((x) => x.inStock && x.imageUrl) ?? products[0] ?? null;
  const rail = products.slice(0, RAIL_MAX);
  const stock = Object.fromEntries(products.map((x) => [x.id, x.variants]));
  return (
    <>
      <DropHero brandName={p.brandName} hero={p.hero} hasTienda={p.hasTienda} featured={featured} />

      {rail.length > 0 && (
        <section id="novedades" aria-labelledby="novedades-titulo" className="py-12 md:py-20">
          <div className="mx-auto flex max-w-[1400px] items-end justify-between gap-4 px-5 pb-6 md:px-10 md:pb-10">
            <h2 id="novedades-titulo" className="dp-heading">
              {p.copy.shopTitle || 'Novedades'}
            </h2>
            <Link href="/tienda" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
              Ver todo <ArrowUpRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
          <div className="dp-rail" role="region" aria-label="Novedades de la tienda" tabIndex={0}>
            <ul className="dp-rail-list">
              {rail.map((x, i) => (
                <li key={x.id} className="dp-rail-item">
                  <DropCard product={x} tone={toneAt(i)} priority={i < 3} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <ContentSections template="drop" sections={p.sections} slot="before-about" />

      {p.copy.aboutText && (
        <section id="sobre-nosotros" data-tone="muted">
          <div className="mx-auto grid max-w-[1400px] gap-6 px-5 py-14 md:grid-cols-12 md:gap-x-8 md:px-10 md:py-24">
            <h2 className="dp-label md:col-span-3">{p.copy.aboutTitle || `Sobre ${p.brandName}`}</h2>
            <p className="font-display text-2xl font-bold leading-snug tracking-tight whitespace-pre-line md:col-span-8 md:text-4xl md:leading-[1.15]">{p.copy.aboutText}</p>
          </div>
        </section>
      )}

      <ContentSections template="drop" sections={p.sections} slot="after-about" />

      {p.hasEntradas && (
        <section id="eventos" aria-labelledby="eventos-titulo" className="mx-auto max-w-[1400px] px-5 py-12 md:px-10 md:py-20">
          <div className="flex items-end justify-between gap-4 pb-6 md:pb-10">
            <h2 id="eventos-titulo" className="dp-heading">
              Eventos
            </h2>
            {p.events.length > 0 && !p.loadError && (
              <Link href="/eventos" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                Ver todos <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
            )}
          </div>
          {p.loadError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 px-6 py-12 text-center">
              <WifiOff className="mx-auto mb-4 h-10 w-10 text-destructive/70" aria-hidden />
              <h3 className="dp-heading !text-2xl">No hemos podido cargar los eventos</h3>
              <p className="mx-auto mb-6 mt-2 max-w-md text-muted-foreground">Parece un fallo de conexión o del servidor: no es que no haya fechas publicadas.</p>
              <ReloadButton label="Reintentar" className="gap-2 font-semibold" />
            </div>
          ) : p.events.length === 0 ? (
            <p className="border-y border-border py-12 text-lg text-muted-foreground">Aún no hay eventos publicados. Vuelve pronto.</p>
          ) : (
            <DropEvents events={p.events.slice(0, 6)} />
          )}
        </section>
      )}

      {p.hasSponsors && <LinkBlock href="/sponsors" title={p.copy.sponsorsTitle || '¿Quieres patrocinar nuestros eventos?'} text={p.copy.sponsorsSubtitle} />}

      {p.contactEnabled && (
        <section id="contacto" className="scroll-mt-20">
          <div className="mx-auto grid max-w-[1400px] gap-10 px-5 py-14 md:grid-cols-12 md:gap-x-8 md:px-10 md:py-24">
            <div className="md:col-span-4">
              <h2 className="dp-heading">Contacto</h2>
              <p className="mt-3 text-muted-foreground">Cuéntanos qué necesitas y te respondemos por email.</p>
            </div>
            <div className="max-w-2xl md:col-span-7 md:col-start-6">
              <ContactForm />
            </div>
          </div>
        </section>
      )}

      {rail.length > 0 && <DropCart stock={stock} />}
    </>
  );
}
