import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, MapPin, ArrowRight, Ticket, Sparkles, Music, Zap } from 'lucide-react';
import { FadeIn, SlideIn, Stagger, StaggerItem } from '@/components/ui/animate';
import { Logo } from '@/components/logo';
import Image from 'next/image';

export const dynamic = 'force-dynamic';

type EventWithTicketTypes = Prisma.EventGetPayload<{ include: { ticketTypes: true } }>;

export default async function HomePage() {
  let events: EventWithTicketTypes[] = [];
  try {
    events = await prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      include: { ticketTypes: { where: { isActive: true }, orderBy: { price: 'asc' }, take: 1 } },
      orderBy: { date: 'asc' },
      take: 6,
    });
  } catch (error) {
    console.error('[HomePage] Error al cargar eventos:', error);
  }

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden min-h-[85vh] flex items-center">
        {/* Background with brand gradient */}
        <div className="absolute inset-0 hero-gradient" />
        <div className="absolute inset-0 texture-noise" />

        {/* Decorative elements */}
        <div className="absolute top-20 right-10 w-32 h-32 rounded-full bg-lima/10 blur-3xl" />
        <div className="absolute bottom-20 left-10 w-40 h-40 rounded-full bg-neon-pink/8 blur-3xl" />
        <div className="absolute top-1/3 right-1/4 w-24 h-24 rounded-full bg-primary/15 blur-2xl" />

        {/* Pegatina decorativa — el mismo lenguaje visual de "pegatina de feria" ya
            documentado en DESIGN.md, aquí como foto real en vez de sombra sintética */}
        <Image
          src="/brand/sticker-wordmark.png"
          alt=""
          width={441}
          height={254}
          aria-hidden
          className="hidden lg:block absolute top-24 right-[8%] w-40 h-auto rotate-[8deg] drop-shadow-2xl select-none pointer-events-none"
        />

        <div className="relative max-w-[1200px] mx-auto px-4 py-24 md:py-32">
          <FadeIn>
            {/* Sticker badge — anuncia el próximo evento real, nunca una campaña fija */}
            <div className="inline-flex brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mb-8">
              <Sparkles className="h-4 w-4" />
              {events?.[0] ? `PRÓXIMO EVENTO: ${events[0].name.toUpperCase()}` : 'GOOD VIBES DE FERIA'}
            </div>

            <h1 className="mb-6">
              <span className="sr-only">La Grailla</span>
              <Logo variant="white" aria-hidden className="h-16 md:h-24 lg:h-28" priority />
            </h1>

            <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mb-4 font-display font-medium">
              Caseta de feria, noches de DJ y las mejores vibras de Torremolinos.
            </p>
            <p className="text-base md:text-lg text-muted-foreground/70 max-w-xl mb-10">
              ¿Te vienes? Compra tus entradas online y asegura tu plaza. 🎉
            </p>

            <div className="flex flex-wrap gap-4">
              <Link href="/eventos">
                <Button size="lg" className="gap-2 text-base font-display font-semibold px-8 h-12 rounded-full shadow-lg shadow-primary/25">
                  <Ticket className="h-5 w-5" />
                  Ver Eventos
                </Button>
              </Link>
              <Link href="/tienda">
                <Button size="lg" variant="outline" className="gap-2 text-base font-display font-semibold px-8 h-12 rounded-full border-2">
                  <Zap className="h-5 w-5" />
                  Tienda
                </Button>
              </Link>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Events */}
      {(events?.length ?? 0) > 0 && (
        <section className="max-w-[1200px] mx-auto px-4 py-20">
          <SlideIn from="bottom">
            <div className="flex items-center justify-between mb-10">
              <div>
                <h2 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
                  Próximos Eventos 🔥
                </h2>
                <p className="text-muted-foreground mt-2 text-lg">No te quedes fuera. ¡Avisa a tu gente!</p>
              </div>
              <Link href="/eventos">
                <Button variant="ghost" className="gap-2 font-display font-semibold">
                  Ver todos <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </SlideIn>

          <Stagger staggerDelay={0.1}>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {(events ?? []).map((event, index) => {
                const dateStr = event?.date
                  ? new Date(event.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
                  : '';
                const minPrice = event?.ticketTypes?.[0]?.price;
                return (
                  <StaggerItem key={event?.id ?? `ev-${index}`}>
                    <Link href={`/eventos/${event?.slug ?? ''}`}>
                      <Card variant="interactive" className="overflow-hidden group border-2 border-border/50 hover:border-primary/40 transition-all">
                        <div className="aspect-[16/9] bg-gradient-to-br from-primary/20 via-primary/5 to-lima/5 relative flex items-center justify-center">
                          {event?.imageUrl ? (
                            <img src={event.imageUrl} alt={event?.name ?? ''} className="object-cover w-full h-full" />
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
        </section>
      )}

      {/* CTA */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-transparent to-lima/10" />
        <div className="relative max-w-[1200px] mx-auto px-4 py-20 text-center">
          <FadeIn>
            <h2 className="font-display text-3xl md:text-4xl font-bold mb-4">
              ¿Quieres patrocinar nuestros eventos?
            </h2>
            <p className="text-muted-foreground text-lg mb-8 max-w-xl mx-auto">
              Llega a miles de asistentes. Tu marca en la mejor feria de la costa.
            </p>
            <Link href="/sponsors">
              <Button size="lg" variant="outline" className="gap-2 font-display font-semibold px-8 h-12 rounded-full border-2">
                Ser Sponsor
              </Button>
            </Link>
          </FadeIn>
        </div>
      </section>
    </>
  );
}
