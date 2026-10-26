import { getActiveModules } from '@/lib/modules/runtime';
import Link from 'next/link';
import { prisma, type EventWithTicketTypes } from '@/lib/prisma';
import { getConfigs } from '@/lib/config';
import { EVENT_GRACE_PERIOD_MS } from '@/lib/active-event';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, MapPin, ArrowRight, Music, ShoppingBag, Handshake, WifiOff } from 'lucide-react';
import { FadeIn, SlideIn, Stagger, StaggerItem } from '@/components/ui/animate';
import { ReloadButton } from '@/components/reload-button';
import { getBrand } from '@/lib/brand/brand';
import { ContactForm } from '@/components/contact-form';
import { HeroFeria } from './_home/hero-feria';
import { HeroEditorial } from './_home/hero-editorial';
import type { HeroProps } from './_home/hero';
import { HomeMarquesina } from './_home/marquesina/home-marquesina';
import { HomeGaleria } from './_home/galeria/home-galeria';
import { HomeTipo } from './_home/tipo/home-tipo';
import { HomeEstudio } from './_home/estudio/home-estudio';
import { HomeCine } from './_home/cine/home-cine';
import { HomeDrop } from './_home/drop/home-drop';
import { getShopProducts } from '@/lib/shop/products';
import { toTemplateEvent } from './_home/event-view';
import { ContentSections } from './_home/sections/content-sections';
import { canonicalAlternates } from '@/lib/seo/canonical';
import { EVENT_TIMEZONE } from '@/lib/event-time';
import { getContentSections } from '@/lib/content/load';

// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

/** Sin el módulo Entradas no hay eventos que cargar (ni error). */
class SkipEvents extends Error {}

export function generateMetadata() {
  return canonicalAlternates('/');
}

export default async function HomePage() {
  // Cada sección de módulo solo aparece si el cliente lo tiene (en una instalación única, todos).
  const modules = getActiveModules();
  const brand = await getBrand();
  const hasEntradas = modules.includes('entradas');
  let events: EventWithTicketTypes[] = [];
  let loadError = false;
  try {
    if (!hasEntradas) throw new SkipEvents();
    events = await prisma.event.findMany({
      // No anunciar como "próxima noche" un evento cuya fecha ya pasó (más el
      // margen de gracia nocturno) — sin este filtro, un PUBLISHED que nadie
      // marcó a mano como FINISHED se seguía vendiendo indefinidamente.
      where: { status: 'PUBLISHED', date: { gte: new Date(Date.now() - EVENT_GRACE_PERIOD_MS) } },
      include: { ticketTypes: { where: { isActive: true }, orderBy: { price: 'asc' }, take: 1 } },
      orderBy: { date: 'asc' },
      take: 6,
    });
  } catch (error) {
    if (!(error instanceof SkipEvents)) {
      console.error('[HomePage] Error al cargar eventos:', error);
      loadError = true;
    }
  }

  const copy = await getConfigs([
    'home_hero_badge_fallback',
    'home_hero_subtitle_1',
    'home_hero_subtitle_2',
    'home_events_more_subtitle',
    'home_shop_title',
    'home_shop_subtitle',
    'home_about_title',
    'home_about_text',
    'contact_form_enabled',
    'home_sponsors_cta_title',
    'home_sponsors_cta_subtitle',
  ]);

  // Servicios, proyectos, equipo y preguntas frecuentes del cliente (núcleo): cada una solo existe si tiene elementos.
  const sections = await getContentSections();

  const featured = events[0] ?? null;
  const rest = events.slice(1);
  const featuredDate = featured?.date
    ? new Date(featured.date).toLocaleDateString('es-ES', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: EVENT_TIMEZONE,
      })
    : '';
  const featuredPrice = featured?.ticketTypes?.[0]?.price;

  const primaryCta: HeroProps['primaryCta'] = hasEntradas
    ? { href: '/eventos', label: 'Ver eventos', icon: 'ticket' }
    : modules.includes('tienda')
      ? { href: '/tienda', label: 'Ir a la tienda', icon: 'shop' }
      : copy.contact_form_enabled === 'true'
        ? { href: '#contacto', label: 'Contacta con nosotros', icon: 'mail' }
        : null;
  const hero: HeroProps = {
    brandName: brand.name,
    featured: featured
      ? {
          name: featured.name,
          slug: featured.slug,
          imageUrl: featured.imageUrl ?? null,
          dateLabel: featuredDate,
          place: [featured.venue, featured.city].filter(Boolean).join(', '),
          fromPrice: featuredPrice ?? null,
        }
      : null,
    badge: copy.home_hero_badge_fallback,
    title: copy.home_hero_subtitle_1 || brand.tagline || brand.name,
    subtitle: copy.home_hero_subtitle_2,
    primaryCta,
    stickerImage: brand.stickerImage,
  };
  // Plantillas nuevas (marquesina, galería): otra composición completa de la portada (Feria y Editorial siguen por el camino de siempre).
  if (brand.template === 'marquesina' || brand.template === 'galeria' || brand.template === 'tipo' || brand.template === 'estudio' || brand.template === 'cine' || brand.template === 'drop') {
    const Home = { marquesina: HomeMarquesina, galeria: HomeGaleria, tipo: HomeTipo, estudio: HomeEstudio, cine: HomeCine, drop: HomeDrop }[brand.template];
    // La portada de «drop» enseña productos: solo se leen con esa plantilla y con el módulo Tienda (un fallo de lectura deja la portada sin riel, no la rompe).
    const products = brand.template === 'drop' && modules.includes('tienda') ? await getShopProducts().catch(() => []) : undefined;
    return (
      <Home
        brandName={brand.name}
        italicAccent={brand.theme?.fonts.display === 'instrument-serif'}
        hero={{ badge: hero.badge, title: hero.title, subtitle: hero.subtitle, primaryCta }}
        events={events.map(toTemplateEvent)}
        loadError={loadError}
        hasEntradas={hasEntradas}
        hasTienda={modules.includes('tienda')}
        hasSponsors={modules.includes('sponsors')}
        contactEnabled={copy.contact_form_enabled === 'true'}
        sections={sections}
        media={{ video: brand.heroVideo, poster: brand.heroPoster }}
        products={products}
        copy={{
          shopTitle: copy.home_shop_title,
          shopSubtitle: copy.home_shop_subtitle,
          aboutTitle: copy.home_about_title,
          aboutText: copy.home_about_text,
          sponsorsTitle: copy.home_sponsors_cta_title,
          sponsorsSubtitle: copy.home_sponsors_cta_subtitle,
        }}
      />
    );
  }

  const Hero = brand.template === 'editorial' ? HeroEditorial : HeroFeria;

  return (
    <>
      {/* Hero: la plantilla del cliente (Apariencia → plantilla) */}
      <Hero {...hero} />

      {/* Programación — sin card duplicada del destacado (ya vive en el hero) */}
      {modules.includes('entradas') && (
      <section className="max-w-[1200px] mx-auto px-4 py-16 md:py-20">
        <SlideIn from="bottom">
          <div className="flex items-end justify-between gap-4 mb-10">
            <div>
              <h2 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
                {featured ? 'Más fechas' : 'Próximos eventos'}
              </h2>
              <p className="text-muted-foreground mt-2 text-lg">
                {featured ? copy.home_events_more_subtitle || `Otras fechas de ${brand.name}` : 'Compra tus entradas online'}
              </p>
            </div>
            {(events?.length ?? 0) > 0 && !loadError && (
              <Link href="/eventos">
                <Button variant="ghost" className="gap-2 font-display font-semibold shrink-0">
                  Ver todos <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            )}
          </div>
        </SlideIn>

        {loadError ? (
          <FadeIn>
            <div
              className="rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-16 text-center"
              role="alert"
            >
              <WifiOff className="h-12 w-12 text-destructive/60 mx-auto mb-4" aria-hidden />
              <h3 className="font-display text-xl font-bold tracking-tight mb-2">
                No hemos podido cargar los eventos
              </h3>
              <p className="text-muted-foreground max-w-md mx-auto mb-6">
                Parece un fallo de conexión o del servidor — no es que no haya fechas publicadas.
              </p>
              <ReloadButton label="Reintentar" className="gap-2 font-display font-semibold" />
            </div>
          </FadeIn>
        ) : (events?.length ?? 0) === 0 ? (
          <FadeIn>
            <div className="rounded-2xl border border-dashed border-border/80 bg-muted/20 px-6 py-16 text-center">
              <Music className="h-12 w-12 text-primary/40 mx-auto mb-4" aria-hidden />
              <h3 className="font-display text-xl font-bold tracking-tight mb-2">
                Estamos montando la próxima fiesta
              </h3>
              <p className="text-muted-foreground max-w-md mx-auto mb-6">
                Aún no hay eventos publicados. Vuelve pronto o síguenos — la programación sale aquí primero.
              </p>
              <Button asChild variant="outline" className="font-display font-semibold">
                <Link href="/eventos">Ir a eventos</Link>
              </Button>
            </div>
          </FadeIn>
        ) : rest.length > 0 ? (
          <Stagger staggerDelay={0.1}>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {rest.map((event, index) => {
                const dateStr = event?.date
                  ? new Date(event.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: EVENT_TIMEZONE })
                  : '';
                const minPrice = event?.ticketTypes?.[0]?.price;
                return (
                  <StaggerItem key={event?.id ?? `ev-${index}`}>
                    <Link href={`/eventos/${event?.slug ?? ''}`}>
                      <Card
                        variant="interactive"
                        className="overflow-hidden group border-2 border-border/50 hover:border-primary/40 transition-all"
                      >
                        <div className="aspect-[16/9] bg-gradient-to-br from-primary/20 via-primary/5 to-lima/5 relative flex items-center justify-center">
                          {event?.imageUrl ? (
                            <img
                              src={event.imageUrl}
                              alt={event?.name ?? ''}
                              className="object-cover w-full h-full"
                            />
                          ) : (
                            <Music className="h-14 w-14 text-primary/30" />
                          )}
                        </div>
                        <CardContent className="p-5">
                          <h3 className="font-display font-bold text-lg mb-2 group-hover:text-primary transition-colors">
                            {event?.name ?? 'Evento'}
                          </h3>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3.5 w-3.5" />
                              <span className="font-mono text-xs">{dateStr}</span>
                            </span>
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5" />
                              {event?.city ?? ''}
                            </span>
                          </div>
                          {minPrice != null && (
                            <div className="mt-3">
                              <Badge variant="secondary" className="text-primary">
                                Desde {minPrice?.toFixed?.(2) ?? '0.00'}€
                              </Badge>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </Link>
                  </StaggerItem>
                );
              })}
            </div>
          </Stagger>
        ) : (
          <FadeIn>
            <div className="flex justify-center">
              <Link href="/eventos">
                <Button variant="outline" className="gap-2 font-display font-semibold">
                  Ver toda la programación <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </FadeIn>
        )}
      </section>
      )}

      {/* Merch — secundario, un solo riel, sin competir con el CTA de entradas */}
      {modules.includes('tienda') && (
      <section className="border-y border-border/40 bg-muted/20">
        <div className="max-w-[1200px] mx-auto px-4 py-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-background border border-border/60">
              <ShoppingBag className="h-5 w-5 text-primary" aria-hidden />
            </div>
            <div>
              <h2 className="font-display font-bold text-lg tracking-tight">{copy.home_shop_title || 'Tienda'}</h2>
              <p className="text-sm text-muted-foreground">{copy.home_shop_subtitle || `Lleva ${brand.name} contigo.`}</p>
            </div>
          </div>
          <Link href="/tienda">
            <Button variant="outline" size="sm" className="gap-2 font-display font-semibold">
              Ir a la tienda <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>
      )}

      <ContentSections template={brand.template} sections={sections} slot="before-about" />

      {/* Sobre nosotros — sección del núcleo; solo aparece si el cliente ha escrito el texto (Configuración → Contenido) */}
      {copy.home_about_text && (
        <section id="sobre-nosotros" className="max-w-[1200px] mx-auto px-4 py-16 md:py-20">
          <FadeIn>
            <div className="grid gap-8 md:grid-cols-12">
              <h2 className="md:col-span-4 font-display text-3xl md:text-4xl font-bold tracking-tight text-balance">
                {copy.home_about_title || `Sobre ${brand.name}`}
              </h2>
              <p className="md:col-span-8 max-w-prose whitespace-pre-line text-lg text-muted-foreground">{copy.home_about_text}</p>
            </div>
          </FadeIn>
        </section>
      )}

      <ContentSections template={brand.template} sections={sections} slot="after-about" />

      {/* Patrocinio — terciario */}
      {modules.includes('sponsors') && (
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-transparent to-lima/10" />
        <div className="relative max-w-[1200px] mx-auto px-4 py-16 text-center">
          <FadeIn>
            <div className="inline-flex items-center gap-2 text-muted-foreground mb-3 justify-center">
              <Handshake className="h-4 w-4" aria-hidden />
              <span className="text-xs font-display font-semibold uppercase tracking-wide">Marcas</span>
            </div>
            <h2 className="font-display text-2xl md:text-3xl font-bold mb-3">{copy.home_sponsors_cta_title || '¿Quieres patrocinar nuestros eventos?'}</h2>
            {copy.home_sponsors_cta_subtitle && (
              <p className="text-muted-foreground text-base mb-6 max-w-xl mx-auto">{copy.home_sponsors_cta_subtitle}</p>
            )}
            <Link href="/sponsors">
              <Button
                size="lg"
                variant="ghost"
                className="gap-2 font-display font-semibold underline-offset-4 hover:underline"
              >
                Ser patrocinador
              </Button>
            </Link>
          </FadeIn>
        </div>
      </section>
      )}

      {/* Contacto — sección del núcleo (formulario → bandeja de mensajes). Se activa en Configuración → Contenido. */}
      {copy.contact_form_enabled === 'true' && (
        <section id="contacto" className="border-t border-border/40 scroll-mt-20">
          <div className="max-w-[1200px] mx-auto px-4 py-16 md:py-20 grid gap-10 md:grid-cols-12">
            <div className="md:col-span-4">
              <h2 className="font-display text-3xl md:text-4xl font-bold tracking-tight text-balance">Contacto</h2>
              <p className="mt-3 text-muted-foreground">Cuéntanos qué necesitas y te respondemos por email.</p>
            </div>
            <div className="md:col-span-8 max-w-2xl">
              <ContactForm />
            </div>
          </div>
        </section>
      )}
    </>
  );
}
