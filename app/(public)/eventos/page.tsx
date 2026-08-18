import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, MapPin, Music, Users } from 'lucide-react';
import { FadeIn, Stagger, StaggerItem } from '@/components/ui/animate';
import { Container } from '@/components/layouts/container';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Eventos | La Grailla',
  description: 'Todas las noches, todas las fiestas de La Grailla. Descubre los próximos eventos y compra tus entradas online.',
};

type EventWithTicketTypes = Prisma.EventGetPayload<{ include: { ticketTypes: true } }>;

export default async function EventosPage() {
  let events: EventWithTicketTypes[] = [];
  try {
    events = await prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      include: { ticketTypes: { where: { isActive: true }, orderBy: { price: 'asc' }, take: 1 } },
      orderBy: { date: 'asc' },
    });
  } catch (error) {
    console.error('[EventosPage] Error al cargar eventos:', error);
  }

  return (
    <Container size="lg">
      <div className="py-10">
        <FadeIn>
          <div className="mb-10">
            <div className="inline-flex brand-sticker text-xs text-lima border-lima/60 shadow-lima/30 mb-4">
              🎶 PROGRAMACIÓN
            </div>
            <h1 className="font-display text-3xl md:text-5xl font-bold tracking-tight mb-3">
              Eventos
            </h1>
            <p className="text-muted-foreground text-lg max-w-xl">
              Todas las noches, todas las fiestas. ¡No te quedes fuera! 🔥
            </p>
          </div>
        </FadeIn>

        {(events?.length ?? 0) === 0 ? (
          <FadeIn>
            <div className="text-center py-20">
              <Music className="h-14 w-14 text-muted-foreground/40 mx-auto mb-4" />
              <p className="text-muted-foreground font-display text-lg">Aún no hay eventos publicados. ¡Pronto habrá novedades!</p>
            </div>
          </FadeIn>
        ) : (
          <Stagger staggerDelay={0.08}>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {(events ?? []).map((event, index) => {
                const dateStr = event?.date
                  ? new Date(event.date).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
                  : '';
                const minPrice = event?.ticketTypes?.[0]?.price;
                const spotsLeft = (event?.maxCapacity ?? 0) - (event?.currentCount ?? 0);
                return (
                  <StaggerItem key={event?.id ?? `ev-${index}`}>
                    <Link href={`/eventos/${event?.slug ?? ''}`}>
                      <Card variant="interactive" className="overflow-hidden h-full group border-2 border-border/50 hover:border-primary/40 transition-all">
                        <div className="aspect-[16/9] bg-gradient-to-br from-primary/20 via-primary/5 to-lima/5 relative flex items-center justify-center">
                          {event?.imageUrl ? (
                            <img src={event.imageUrl} alt={event?.name ?? ''} className="object-cover w-full h-full" />
                          ) : (
                            <Music className="h-14 w-14 text-primary/30" />
                          )}
                          {spotsLeft <= 50 && spotsLeft > 0 && (
                            <Badge variant="destructive" className="absolute top-3 right-3 text-xs">
                              ¡Últimas {spotsLeft} plazas!
                            </Badge>
                          )}
                        </div>
                        <CardContent className="p-5">
                          <h3 className="font-display font-bold text-lg mb-2 group-hover:text-primary transition-colors">
                            {event?.name ?? 'Evento'}
                          </h3>
                          <div className="space-y-1.5 text-sm text-muted-foreground">
                            <p className="flex items-center gap-1.5">
                              <Calendar className="h-3.5 w-3.5" />
                              <span className="font-mono text-xs">{dateStr}</span>
                            </p>
                            <p className="flex items-center gap-1.5">
                              <MapPin className="h-3.5 w-3.5" /> {event?.venue ?? ''}, {event?.city ?? ''}
                            </p>
                            <p className="flex items-center gap-1.5">
                              <Users className="h-3.5 w-3.5" /> Aforo: {event?.maxCapacity ?? 0}
                            </p>
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
        )}
      </div>
    </Container>
  );
}
