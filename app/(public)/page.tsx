import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getConfigs } from '@/lib/config';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, MapPin, ArrowRight, Ticket, Sparkles, Music, ShoppingBag, Handshake, WifiOff } from 'lucide-react';
import { FadeIn, SlideIn, Stagger, StaggerItem } from '@/components/ui/animate';
import { Logo } from '@/components/logo';
import { ReloadButton } from '@/components/reload-button';
import Image from 'next/image';

export const revalidate = 60;

type EventWithTicketTypes = Prisma.EventGetPayload<{ include: { ticketTypes: true } }>;

export default async function HomePage() {
  let events: EventWithTicketTypes[] = [];
  let loadError = false;
  try {
    events = await prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      include: { ticketTypes: { where: { isActive: true }, orderBy: { price: 'asc' }, take: 1 } },
      orderBy: { date: 'asc' },
      take: 6,
    });
  } catch (error) {
    console.error('[HomePage] Error al cargar eventos:', error);
    loadError = true;
  }

  const copy = await getConfigs([
    'home_hero_badge_fallback',
    'home_hero_subtitle_1',
    'home_hero_subtitle_2',
    'home_sponsors_cta_title',
    'home_sponsors_cta_subtitle',
  ]);

  const featured = events[0] ?? null;
  const rest = events.slice(1);
  const featuredDate = featured?.date
    ? new Date(featured.date).toLocaleDateString('es-ES', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    : '';
  const featuredPrice = featured?.ticketTypes?.[0]?.price;
  const featuredHref = featured ? `/eventos/${featured.slug}` : '/eventos';
  const buyHref = featured ? `/eventos/${featured.slug}/comprar` : '/eventos';

  return (
    <>
      {/* Hero = cartel de la próxima noche (o marca si aún no hay fecha) */}
      <section className="relative overflow-hidden min-h-[85vh] flex items-end md:items-center">
        {featured?.imageUrl ? (
          <>
            {/* img nativo: las URLs de cartel pueden ser externas / uploads sin domain allowlist */}
            <img
              src={featured.imageUrl}
              alt=""
              aria-hidden
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-background/30" />
            <div className="absolute inset-0 bg-gradient-to-r from-background/90 via-background/40 to-transparent" />
          </>
        ) : (
          <>
            <div className="absolute inset-0 hero-gradient" />
            <div className="absolute inset-0 texture-noise" />
            <div className="absolute top-20 right-10 w-32 h-32 rounded-full bg-lima/10 blur-3xl" />
            <div className="absolute bottom-20 left-10 w-40 h-40 rounded-full bg-neon-pink/8 blur-3xl" />
          </>
        )}

        {!featured && (
          <Image
            src="/brand/sticker-wordmark.png"
            alt=""
            width={441}
            height={254}
            aria-hidden
            className="hidden lg:block absolute top-24 right-[8%] w-40 h-auto rotate-[8deg] drop-shadow-2xl select-none pointer-events-none"
          />
        )}

        <div className="relative max-w-[1200px] mx-auto px-4 py-24 md:py-32 w-full">
          <FadeIn>
            <div className="mb-6">
              <Logo variant="white" className="h-8 sm:h-9" priority />
              <span className="sr-only">La Grailla</span>
            </div>

            {featured ? (
              <>
                <div className="inline-flex brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mb-5 gap-1.5">
                  <Sparkles className="h-4 w-4" /> PRÓXIMA NOCHE
                </div>
                <h1 className="font-display text-4xl sm:text-5xl md:text-7xl font-bold tracking-tight leading-[0.92] max-w-3xl mb-5">
                  {featured.name}
                </h1>
                <div className="flex flex-wrap gap-3 mb-8 text-sm text-muted-foreground">
                  {featuredDate && (
                    <Badge variant="secondary" className="gap-1.5 font-normal">
                      <Calendar className="h-3.5 w-3.5" />
                      <span className="font-mono text-xs capitalize">{featuredDate}</span>
                    </Badge>
                  )}
                  <Badge variant="secondary" className="gap-1.5 font-normal">
                    <MapPin className="h-3.5 w-3.5" />
                    {[featured.venue, featured.city].filter(Boolean).join(', ')}
                  </Badge>
                  {featuredPrice != null && (
                    <Badge variant="secondary" className="text-primary font-semibold">
                      Desde {featuredPrice.toFixed(2)}€
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <Link href={buyHref}>
                    <Button
                      size="lg"
                      className="gap-2 text-base font-display font-semibold px-8 h-12 rounded-full shadow-lg shadow-primary/25"
                    >
                      <Ticket className="h-5 w-5" />
                      Comprar entradas
                    </Button>
                  </Link>
                  <Link
                    href={featuredHref}
                    className="text-sm font-display font-semibold text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
                  >
                    Ver ficha
                  </Link>
                </div>
              </>
            ) : (
              <>
                <div className="inline-flex brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mb-8 gap-1.5">
                  <Sparkles className="h-4 w-4" />
                  {copy.home_hero_badge_fallback}
                </div>
                <h1 className="mb-6 font-display text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight max-w-2xl leading-[0.95]">
                  {copy.home_hero_subtitle_1}
                </h1>
                <p className="text-base md:text-lg text-muted-foreground/70 max-w-xl mb-10">
                  {copy.home_hero_subtitle_2}
                </p>
                <Link href="/eventos">
                  <Button
                    size="lg"
                    className="gap-2 text-base font-display font-semibold px-8 h-12 rounded-full shadow-lg shadow-primary/25"
                  >
                    <Ticket className="h-5 w-5" />
                    Ver eventos
                  </Button>
                </Link>
              </>
            )}
          </FadeIn>
        </div>
      </section>

      {/* Programación — sin card duplicada del destacado (ya vive en el hero) */}
      <section className="max-w-[1200px] mx-auto px-4 py-16 md:py-20">
        <SlideIn from="bottom">
          <div className="flex items-end justify-between gap-4 mb-10">
            <div>
              <h2 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
                {featured ? 'Más fechas' : 'Próximos eventos'}
              </h2>
              <p className="text-muted-foreground mt-2 text-lg">
                {featured ? 'Otras noches de La Grailla' : 'Compra tus entradas online'}
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
                  ? new Date(event.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
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

      {/* Merch — secundario, un solo riel, sin competir con el CTA de entradas */}
      <section className="border-y border-border/40 bg-muted/20">
        <div className="max-w-[1200px] mx-auto px-4 py-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-background border border-border/60">
              <ShoppingBag className="h-5 w-5 text-primary" aria-hidden />
            </div>
            <div>
              <h2 className="font-display font-bold text-lg tracking-tight">Merch oficial</h2>
              <p className="text-sm text-muted-foreground">Lleva La Grailla contigo. Bajo pedido.</p>
            </div>
          </div>
          <Link href="/tienda">
            <Button variant="outline" size="sm" className="gap-2 font-display font-semibold">
              Ir a la tienda <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Patrocinio — terciario */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-transparent to-lima/10" />
        <div className="relative max-w-[1200px] mx-auto px-4 py-16 text-center">
          <FadeIn>
            <div className="inline-flex items-center gap-2 text-muted-foreground mb-3 justify-center">
              <Handshake className="h-4 w-4" aria-hidden />
              <span className="text-xs font-display font-semibold uppercase tracking-wide">Marcas</span>
            </div>
            <h2 className="font-display text-2xl md:text-3xl font-bold mb-3">{copy.home_sponsors_cta_title}</h2>
            <p className="text-muted-foreground text-base mb-6 max-w-xl mx-auto">
              {copy.home_sponsors_cta_subtitle}
            </p>
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
    </>
  );
}
