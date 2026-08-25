import { prisma } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import { hasEventEnded } from '@/lib/active-event';
import type { Prisma } from '@prisma/client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, MapPin, Clock, Users, ShieldCheck, Ticket, AlertTriangle, Music } from 'lucide-react';
import { FadeIn, SlideIn } from '@/components/ui/animate';
import { Container } from '@/components/layouts/container';
import { MobileBuyBar } from './_components/mobile-buy-bar';
import { ReloadButton } from '@/components/reload-button';

export const revalidate = 60;

type EventWithTicketTypes = Prisma.EventGetPayload<{ include: { ticketTypes: true } }>;

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const event = await prisma.event.findUnique({ where: { slug: params?.slug } });
  if (!event) return { title: 'Evento | La Grailla' };
  return {
    title: `${event.name} | La Grailla`,
    description: `${event.name} en ${event.venue}, ${event.city}. Compra tus entradas online.`,
    openGraph: event.imageUrl ? { images: [{ url: event.imageUrl }] } : undefined,
  };
}

export default async function EventoDetailPage({ params }: { params: { slug: string } }) {
  let event: EventWithTicketTypes | null = null;
  let loadError = false;
  try {
    event = await prisma.event.findUnique({
      where: { slug: params?.slug },
      include: {
        ticketTypes: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
  } catch (error) {
    console.error('[EventoDetailPage] Error al cargar el evento:', error);
    loadError = true;
  }

  if (loadError) {
    return (
      <Container size="md">
        <div className="py-20 text-center space-y-4" role="alert">
          <p className="font-display text-xl font-bold tracking-tight">No hemos podido cargar el evento</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Fallo de conexión o del servidor. Prueba de nuevo en unos segundos.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <ReloadButton label="Reintentar" className="gap-2" />
            <Button asChild variant="outline">
              <Link href="/eventos">Ver programación</Link>
            </Button>
          </div>
        </div>
      </Container>
    );
  }

  if (!event) notFound();

  const dateStr = event?.date
    ? new Date(event.date).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const spotsLeft = (event?.maxCapacity ?? 0) - (event?.currentCount ?? 0);
  const mapQuery =
    event?.latitude != null && event?.longitude != null
      ? `${event.latitude},${event.longitude}`
      : [event?.venue, event?.address, event?.city].filter(Boolean).join(', ');
  const artists = (event?.artists ?? '').split(',').map((a) => a?.trim?.()).filter(Boolean);
  const activeTypes = event?.ticketTypes ?? [];
  const minPrice = activeTypes.length
    ? Math.min(...activeTypes.map((tt) => tt?.price ?? 0))
    : null;
  const anyTicketsLeft = activeTypes.some(
    (tt) => (tt?.maxQuantity ?? 0) - (tt?.soldCount ?? 0) > 0
  );
  const soldOut = spotsLeft <= 0 || !anyTicketsLeft || activeTypes.length === 0;
  const eventEnded = hasEventEnded(event?.date);

  const ticketsCard = (
    <Card id="entradas">
      <CardContent className="p-6">
        <h2 className="font-display font-bold text-lg mb-1 flex items-center gap-2">
          <Ticket className="h-5 w-5 text-primary" /> Entradas
        </h2>
        <p className="text-sm text-muted-foreground mb-4 flex items-center gap-1">
          <Users className="h-3.5 w-3.5" />
          {eventEnded ? 'Evento finalizado' : spotsLeft > 0 ? `${spotsLeft} plazas disponibles` : 'Sin plazas online'}
        </p>
        <div className="space-y-3">
          {activeTypes.map((tt) => {
            const available = (tt?.maxQuantity ?? 0) - (tt?.soldCount ?? 0);
            const typeSoldOut = available <= 0;
            return (
              <div key={tt?.id} className="p-3 rounded-lg bg-muted/50">
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{tt?.name ?? ''}</p>
                    <p className="text-xs text-muted-foreground">{tt?.phaseName ?? ''}</p>
                  </div>
                  <p className="font-bold text-primary shrink-0">{(tt?.price ?? 0).toFixed(2)}€</p>
                </div>
                {typeSoldOut && (
                  <Badge variant="destructive" className="mt-2 text-xs">
                    Agotado
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
        {!soldOut && !eventEnded && (
          <Link href={`/eventos/${event?.slug ?? ''}/comprar`} className="hidden lg:block">
            <Button
              className="w-full mt-4 gap-2 font-display font-semibold rounded-full shadow-lg shadow-primary/25"
              size="lg"
            >
              <Ticket className="h-5 w-5" /> Comprar entradas
            </Button>
          </Link>
        )}
      </CardContent>
    </Card>
  );

  return (
    <>
      {/* Cartel full-bleed — mismo lenguaje visual que el hero de home */}
      <div className="relative overflow-hidden min-h-[42vh] md:min-h-[48vh] flex items-end">
        {event?.imageUrl ? (
          <>
            <img
              src={event.imageUrl}
              alt=""
              aria-hidden
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-background/20" />
          </>
        ) : (
          <div className="absolute inset-0 hero-gradient" />
        )}
        <Container size="lg" className="relative w-full pb-8 pt-28">
          <FadeIn>
            <h1 className="font-display text-3xl md:text-5xl font-bold tracking-tight max-w-3xl leading-[0.95]">
              {event?.name ?? ''}
            </h1>
            <div className="flex flex-wrap gap-3 mt-4">
              <Badge variant="secondary" className="gap-1">
                <Calendar className="h-3 w-3" /> {dateStr}
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <Clock className="h-3 w-3" /> {event?.doorsOpen ?? ''} — {event?.endTime ?? ''}
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <MapPin className="h-3 w-3" /> {event?.venue ?? ''}, {event?.city ?? ''}
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <ShieldCheck className="h-3 w-3" /> +{event?.minAge ?? 18}
              </Badge>
            </div>
          </FadeIn>
        </Container>
      </div>

      <Container size="lg">
        {/* pb-24 en móvil: hueco para la barra fija de compra */}
        <div className="py-8 pb-28 lg:pb-8">
          <div className="grid lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              {/* En móvil: entradas justo debajo del título, antes del scroll largo */}
              <div className="lg:hidden">
                <SlideIn from="bottom">{ticketsCard}</SlideIn>
              </div>

              {event?.description && (
                <SlideIn from="left" delay={0.1}>
                  <Card>
                    <CardContent className="p-6">
                      <p className="text-muted-foreground leading-relaxed whitespace-pre-line">
                        {event.description}
                      </p>
                    </CardContent>
                  </Card>
                </SlideIn>
              )}

              {artists?.length > 0 && (
                <SlideIn from="left" delay={0.2}>
                  <Card>
                    <CardContent className="p-6">
                      <h2 className="font-display font-bold text-lg mb-3 flex items-center gap-2">
                        <Music className="h-4 w-4 text-primary" /> Artistas
                      </h2>
                      <div className="flex flex-wrap gap-2">
                        {artists.map((a, i) => (
                          <Badge key={i} variant="outline" className="text-sm">
                            {a}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </SlideIn>
              )}

              {event?.conditions && (
                <SlideIn from="left" delay={0.3}>
                  <Card id="condiciones">
                    <CardContent className="p-6">
                      <h2 className="font-display font-bold text-lg mb-3 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-warm-yellow" /> Condiciones de acceso
                      </h2>
                      <p className="text-muted-foreground text-sm whitespace-pre-line">{event.conditions}</p>
                    </CardContent>
                  </Card>
                </SlideIn>
              )}

              <SlideIn from="left" delay={0.4}>
                <Card>
                  <CardContent className="p-6">
                    <h2 className="font-display font-bold text-lg mb-3 flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-primary" /> Ubicación
                    </h2>
                    <p className="font-medium">{event?.venue ?? ''}</p>
                    <p className="text-muted-foreground">
                      {[event?.address, event?.city].filter(Boolean).join(', ')}
                    </p>
                    {mapQuery && (
                      <>
                        <div className="mt-4 overflow-hidden rounded-xl border border-border/60 bg-muted">
                          <iframe
                            title={`Mapa de ${event?.venue ?? 'la sala'}`}
                            src={`https://maps.google.com/maps?q=${encodeURIComponent(mapQuery)}&z=15&output=embed`}
                            width="100%"
                            height="320"
                            loading="lazy"
                            referrerPolicy="no-referrer-when-downgrade"
                            style={{ border: 0, display: 'block' }}
                          />
                        </div>
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                        >
                          <MapPin className="h-3.5 w-3.5" /> Cómo llegar
                        </a>
                      </>
                    )}
                  </CardContent>
                </Card>
              </SlideIn>
            </div>

            <div className="hidden lg:block lg:col-span-1">
              <SlideIn from="right">
                <div className="sticky top-24 space-y-4">{ticketsCard}</div>
              </SlideIn>
            </div>
          </div>
        </div>
      </Container>

      <MobileBuyBar
        slug={event?.slug ?? ''}
        minPrice={minPrice}
        soldOut={soldOut}
        ended={eventEnded}
      />
    </>
  );
}
