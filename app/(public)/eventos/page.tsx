import Link from 'next/link';
import { blobImgProps, IMG_SIZES } from '@/lib/images/blob-image';
import { prisma, type EventWithTicketTypes } from '@/lib/prisma';
import { EVENT_GRACE_PERIOD_MS } from '@/lib/active-event';
import { getEventDemandLevel } from '@/lib/ticket-availability';
import { getOnlineSalesClosedLabel } from '@/lib/online-sales-closed';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar, MapPin, Music, Ticket, WifiOff } from 'lucide-react';
import { FadeIn, Stagger, StaggerItem } from '@/components/ui/animate';
import { Container } from '@/components/layouts/container';
import { ReloadButton } from '@/components/reload-button';
import { getBrand } from '@/lib/brand/brand';
import { EventosMarquesina } from '../_home/marquesina/eventos-marquesina';
import { EventosGaleria } from '../_home/galeria/eventos-galeria';
import { EventosTipo } from '../_home/tipo/eventos-tipo';
import { EventosEstudio } from '../_home/estudio/eventos-estudio';
import { EventosCine } from '../_home/cine/eventos-cine';
import { EventosDrop } from '../_home/drop/eventos-drop';
import { toTemplateEvent } from '../_home/event-view';
import { canonicalAlternates } from '@/lib/seo/canonical';
import { EVENT_TIMEZONE } from '@/lib/event-time';

// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const { name } = await getBrand();
  return {
    title: 'Eventos',
    description: `Descubre los próximos eventos de ${name} y compra tus entradas online.`,
    ...canonicalAlternates('/eventos'),
  };
}

export default async function EventosPage() {
  let events: EventWithTicketTypes[] = [];
  let loadError = false;
  try {
    events = await prisma.event.findMany({
      where: { status: 'PUBLISHED', date: { gte: new Date(Date.now() - EVENT_GRACE_PERIOD_MS) } },
      include: { ticketTypes: { where: { isActive: true }, orderBy: { price: 'asc' }, take: 1 } },
      orderBy: { date: 'asc' },
    });
  } catch (error) {
    console.error('[EventosPage] Error al cargar eventos:', error);
    loadError = true;
  }

  const brand = await getBrand();
  if (brand.template === 'marquesina') {
    return <EventosMarquesina brandName={brand.name} events={events.map(toTemplateEvent)} loadError={loadError} />;
  }
  if (brand.template === 'drop') {
    return <EventosDrop brandName={brand.name} events={events.map(toTemplateEvent)} loadError={loadError} />;
  }
  if (brand.template === 'cine') {
    return <EventosCine brandName={brand.name} events={events.map(toTemplateEvent)} loadError={loadError} />;
  }
  if (brand.template === 'estudio') {
    return <EventosEstudio brandName={brand.name} events={events.map(toTemplateEvent)} loadError={loadError} />;
  }
  if (brand.template === 'tipo') {
    return <EventosTipo brandName={brand.name} events={events.map(toTemplateEvent)} loadError={loadError} />;
  }
  if (brand.template === 'galeria') {
    return (
      <EventosGaleria
        brandName={brand.name}
        events={events.map(toTemplateEvent)}
        loadError={loadError}
        italicAccent={brand.theme?.fonts.display === 'instrument-serif'}
      />
    );
  }

  const [featured, ...rest] = events;

  return (
    <div className="relative">
      {/* Cabecera full-bleed — cartel de programación, no plantilla de landing genérica */}
      <div className="relative overflow-hidden border-b border-border/40">
        <div className="absolute inset-0 hero-gradient opacity-80" />
        <div className="absolute inset-0 texture-noise" />
        <Container size="lg" className="relative">
          <div className="py-14 md:py-20">
            <FadeIn>
              <div className="inline-flex brand-sticker text-xs text-lima border-lima/60 shadow-lima/30 mb-5 gap-1.5">
                <Music className="h-3.5 w-3.5" /> PROGRAMACIÓN
              </div>
              <h1 className="font-display text-4xl md:text-6xl font-bold tracking-tight mb-4 max-w-2xl leading-[0.95]">
                Noches que no se pierden
              </h1>
              <p className="text-muted-foreground text-lg max-w-xl">
                Elige fecha, compra online y llega con el QR listo.
              </p>
            </FadeIn>
          </div>
        </Container>
      </div>

      <Container size="lg">
        <div className="py-10 pb-16">
          {loadError ? (
            <FadeIn>
              <div
                className="rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-20 text-center"
                role="alert"
              >
                <WifiOff className="h-14 w-14 text-destructive/60 mx-auto mb-4" aria-hidden />
                <h2 className="font-display text-xl font-bold tracking-tight mb-2">
                  No hemos podido cargar la programación
                </h2>
                <p className="text-muted-foreground max-w-md mx-auto mb-6">
                  Fallo de conexión o del servidor — no significa que no haya fechas. Prueba de nuevo.
                </p>
                <ReloadButton label="Reintentar" className="gap-2 font-display font-semibold" />
              </div>
            </FadeIn>
          ) : (events?.length ?? 0) === 0 ? (
            <FadeIn>
              <div className="rounded-2xl border border-dashed border-border/80 bg-muted/20 px-6 py-20 text-center">
                <Music className="h-14 w-14 text-primary/40 mx-auto mb-4" aria-hidden />
                <h2 className="font-display text-xl font-bold tracking-tight mb-2">
                  Todavía no hay fechas publicadas
                </h2>
                <p className="text-muted-foreground max-w-md mx-auto mb-6">
                  Estamos cerrando la próxima noche. Cuando salga, aparecerá aquí primero.
                </p>
                <Button asChild variant="outline">
                  <Link href="/">Volver al inicio</Link>
                </Button>
              </div>
            </FadeIn>
          ) : (
            <div className="space-y-10">
              {featured && (
                <FadeIn>
                  <Link href={`/eventos/${featured.slug}`} className="block group">
                    <Card className="overflow-hidden border-2 border-primary/25 hover:border-primary/45 transition-colors">
                      <div className="grid md:grid-cols-5">
                        <div className="md:col-span-3 aspect-[16/9] md:aspect-auto md:min-h-[320px] bg-gradient-to-br from-primary/25 via-primary/5 to-lima/5 relative flex items-center justify-center">
                          {featured.imageUrl ? (
                            <img
                              {...blobImgProps(featured.imageUrl, { sizes: IMG_SIZES.feature3of5 })}
                              alt={featured.name}
                              className="object-cover w-full h-full transition-transform duration-slow ease-out group-hover:scale-[1.04]"
                            />
                          ) : (
                            <Music className="h-16 w-16 text-primary/30" />
                          )}
                          <Badge className="absolute top-4 left-4 bg-lima text-accent-foreground border-0 font-display">
                            Próximo
                          </Badge>
                        </div>
                        <CardContent className="md:col-span-2 p-6 md:p-8 flex flex-col justify-center gap-4">
                          <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight group-hover:text-primary transition-colors">
                            {featured.name}
                          </h2>
                          <EventMeta event={featured} />
                          <div className="flex items-center gap-2 text-sm font-display font-semibold text-primary pt-2">
                            <Ticket className="h-4 w-4" /> Comprar entradas
                          </div>
                        </CardContent>
                      </div>
                    </Card>
                  </Link>
                </FadeIn>
              )}

              {rest.length > 0 && (
                <Stagger staggerDelay={0.08}>
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {rest.map((event, index) => (
                      <StaggerItem key={event?.id ?? `ev-${index}`}>
                        <EventCard event={event} />
                      </StaggerItem>
                    ))}
                  </div>
                </Stagger>
              )}
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}

function EventMeta({ event }: { event: EventWithTicketTypes }) {
  const dateStr = event?.date
    ? new Date(event.date).toLocaleDateString('es-ES', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: EVENT_TIMEZONE,
      })
    : '';
  const minPrice = event?.ticketTypes?.[0]?.price;
  const demand = getEventDemandLevel(event?.maxCapacity ?? 0, event?.currentCount ?? 0);

  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p className="flex items-center gap-1.5">
        <Calendar className="h-3.5 w-3.5" />
        <span className="font-mono text-xs capitalize">{dateStr}</span>
      </p>
      <p className="flex items-center gap-1.5">
        <MapPin className="h-3.5 w-3.5" /> {event?.venue ?? ''}, {event?.city ?? ''}
      </p>
      {event?.onlineSalesClosed ? (
        <p className="text-xs text-warm-yellow font-medium">{getOnlineSalesClosedLabel(event)}</p>
      ) : demand === 'sold_out' ? (
        <p className="text-xs text-destructive font-medium">Sin plazas online</p>
      ) : demand === 'high' ? (
        <p className="text-xs text-warm-yellow font-medium">Alta demanda</p>
      ) : (
        <p className="text-xs">Plazas disponibles</p>
      )}
      {minPrice != null && (
        <Badge variant="secondary" className="text-primary mt-1">
          Desde {minPrice.toFixed(2)}€
        </Badge>
      )}
    </div>
  );
}

function EventCard({ event }: { event: EventWithTicketTypes }) {
  const demand = getEventDemandLevel(event?.maxCapacity ?? 0, event?.currentCount ?? 0);

  return (
    <Link href={`/eventos/${event?.slug ?? ''}`}>
      <Card
        variant="interactive"
        className="overflow-hidden h-full group border-2 border-border/50 hover:border-primary/40 transition-all"
      >
        <div className="aspect-[16/9] bg-gradient-to-br from-primary/20 via-primary/5 to-lima/5 relative flex items-center justify-center">
          {event?.imageUrl ? (
            <img
              {...blobImgProps(event.imageUrl, { sizes: IMG_SIZES.grid3 })}
              alt={event?.name ?? ''}
              className="object-cover w-full h-full transition-transform duration-slow ease-out group-hover:scale-[1.04]"
            />
          ) : (
            <Music className="h-14 w-14 text-primary/30" />
          )}
          {event?.onlineSalesClosed ? (
            <Badge
              variant="outline"
              className="absolute top-3 right-3 text-xs border-warm-yellow/60 text-warm-yellow bg-warm-yellow/10"
            >
              {getOnlineSalesClosedLabel(event)}
            </Badge>
          ) : demand === 'high' ? (
            <Badge
              variant="outline"
              className="absolute top-3 right-3 text-xs border-warm-yellow/60 text-warm-yellow bg-warm-yellow/10"
            >
              Alta demanda
            </Badge>
          ) : null}
        </div>
        <CardContent className="p-5">
          <h3 className="font-display font-bold text-lg mb-2 group-hover:text-primary transition-colors">
            {event?.name ?? 'Evento'}
          </h3>
          <EventMeta event={event} />
        </CardContent>
      </Card>
    </Link>
  );
}
