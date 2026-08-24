import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar, MapPin, Music, Ticket, WifiOff } from 'lucide-react';
import { FadeIn, Stagger, StaggerItem } from '@/components/ui/animate';
import { Container } from '@/components/layouts/container';
import { ReloadButton } from '@/components/reload-button';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Eventos | La Grailla',
  description:
    'Todas las noches, todas las fiestas de La Grailla. Descubre los próximos eventos y compra tus entradas online.',
};

type EventWithTicketTypes = Prisma.EventGetPayload<{ include: { ticketTypes: true } }>;

export default async function EventosPage() {
  let events: EventWithTicketTypes[] = [];
  let loadError = false;
  try {
    events = await prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      include: { ticketTypes: { where: { isActive: true }, orderBy: { price: 'asc' }, take: 1 } },
      orderBy: { date: 'asc' },
    });
  } catch (error) {
    console.error('[EventosPage] Error al cargar eventos:', error);
    loadError = true;
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
                              src={featured.imageUrl}
                              alt={featured.name}
                              className="object-cover w-full h-full"
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
      })
    : '';
  const minPrice = event?.ticketTypes?.[0]?.price;
  const spotsLeft = (event?.maxCapacity ?? 0) - (event?.currentCount ?? 0);
  const showUrgency = spotsLeft > 0 && spotsLeft <= 50 && (event?.maxCapacity ?? 0) > 0
    ? spotsLeft / (event.maxCapacity ?? 1) <= 0.2
    : false;

  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p className="flex items-center gap-1.5">
        <Calendar className="h-3.5 w-3.5" />
        <span className="font-mono text-xs capitalize">{dateStr}</span>
      </p>
      <p className="flex items-center gap-1.5">
        <MapPin className="h-3.5 w-3.5" /> {event?.venue ?? ''}, {event?.city ?? ''}
      </p>
      {spotsLeft > 0 ? (
        <p className="text-xs">
          {showUrgency ? (
            <span className="text-warm-yellow font-medium">Quedan {spotsLeft} plazas</span>
          ) : (
            <span>{spotsLeft} plazas disponibles</span>
          )}
        </p>
      ) : (
        <p className="text-xs text-destructive font-medium">Sin plazas online</p>
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
  const spotsLeft = (event?.maxCapacity ?? 0) - (event?.currentCount ?? 0);
  const capacity = event?.maxCapacity ?? 0;
  const showUrgency = capacity > 0 && spotsLeft > 0 && spotsLeft / capacity <= 0.2;

  return (
    <Link href={`/eventos/${event?.slug ?? ''}`}>
      <Card
        variant="interactive"
        className="overflow-hidden h-full group border-2 border-border/50 hover:border-primary/40 transition-all"
      >
        <div className="aspect-[16/9] bg-gradient-to-br from-primary/20 via-primary/5 to-lima/5 relative flex items-center justify-center">
          {event?.imageUrl ? (
            <img src={event.imageUrl} alt={event?.name ?? ''} className="object-cover w-full h-full" />
          ) : (
            <Music className="h-14 w-14 text-primary/30" />
          )}
          {showUrgency && (
            <Badge
              variant="outline"
              className="absolute top-3 right-3 text-xs border-warm-yellow/60 text-warm-yellow bg-warm-yellow/10"
            >
              Quedan {spotsLeft} plazas
            </Badge>
          )}
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
