import { prisma } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import type { Prisma } from '@prisma/client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, MapPin, Clock, Users, ShieldCheck, Ticket, AlertTriangle } from 'lucide-react';
import { FadeIn, SlideIn } from '@/components/ui/animate';
import { Container } from '@/components/layouts/container';

export const dynamic = 'force-dynamic';

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
  try {
    event = await prisma.event.findUnique({
      where: { slug: params?.slug },
      include: {
        ticketTypes: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
  } catch (error) {
    console.error('[EventoDetailPage] Error al cargar el evento:', error);
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

  return (
    <Container size="lg">
      <div className="py-8">
        <FadeIn>
          <div className="relative rounded-2xl overflow-hidden aspect-[21/9] bg-gradient-to-br from-primary/25 via-primary/5 to-lima/5 flex items-center justify-center mb-8 border-2 border-border/30">
            {event?.imageUrl ? (
              <img src={event.imageUrl} alt={event?.name ?? ''} className="object-cover w-full h-full" />
            ) : (
              <p aria-hidden className="font-display text-4xl md:text-6xl font-bold text-foreground drop-shadow-sm">{event?.name ?? ''}</p>
            )}
          </div>
        </FadeIn>

        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <SlideIn from="left">
              <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">{event?.name ?? ''}</h1>
              <div className="flex flex-wrap gap-3 mt-4">
                <Badge variant="secondary" className="gap-1"><Calendar className="h-3 w-3" /> {dateStr}</Badge>
                <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" /> {event?.doorsOpen ?? ''} — {event?.endTime ?? ''}</Badge>
                <Badge variant="secondary" className="gap-1"><MapPin className="h-3 w-3" /> {event?.venue ?? ''}, {event?.city ?? ''}</Badge>
                <Badge variant="secondary" className="gap-1"><ShieldCheck className="h-3 w-3" /> +{event?.minAge ?? 18}</Badge>
              </div>
            </SlideIn>

            {event?.description && (
              <SlideIn from="left" delay={0.1}>
                <Card><CardContent className="p-6"><p className="text-muted-foreground leading-relaxed whitespace-pre-line">{event.description}</p></CardContent></Card>
              </SlideIn>
            )}

            {artists?.length > 0 && (
              <SlideIn from="left" delay={0.2}>
                <Card><CardContent className="p-6">
                  <h3 className="font-display font-bold text-lg mb-3">🎶 Artistas</h3>
                  <div className="flex flex-wrap gap-2">{artists.map((a, i) => <Badge key={i} variant="outline" className="text-sm">{a}</Badge>)}</div>
                </CardContent></Card>
              </SlideIn>
            )}

            {event?.conditions && (
              <SlideIn from="left" delay={0.3}>
                <Card><CardContent className="p-6">
                  <h3 className="font-display font-bold text-lg mb-3 flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-yellow-500" /> Condiciones de acceso</h3>
                  <p className="text-muted-foreground text-sm whitespace-pre-line">{event.conditions}</p>
                </CardContent></Card>
              </SlideIn>
            )}

            <SlideIn from="left" delay={0.4}>
              <Card><CardContent className="p-6">
                <h3 className="font-display font-bold text-lg mb-3 flex items-center gap-2"><MapPin className="h-4 w-4 text-primary" /> Ubicación</h3>
                <p className="font-medium">{event?.venue ?? ''}</p>
                <p className="text-muted-foreground">{[event?.address, event?.city].filter(Boolean).join(', ')}</p>
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
              </CardContent></Card>
            </SlideIn>
          </div>

          <div className="lg:col-span-1">
            <SlideIn from="right">
              <div className="sticky top-24 space-y-4">
                <Card><CardContent className="p-6">
                  <h3 className="font-display font-bold text-lg mb-1">🎫 Entradas</h3>
                  <p className="text-sm text-muted-foreground mb-4 flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />
                    {spotsLeft > 0 ? `${spotsLeft} plazas disponibles` : 'Aforo completo'}
                  </p>
                  <div className="space-y-3">
                    {(event?.ticketTypes ?? []).map((tt) => {
                      const available = (tt?.maxQuantity ?? 0) - (tt?.soldCount ?? 0);
                      const soldOut = available <= 0;
                      return (
                        <div key={tt?.id} className="p-3 rounded-lg bg-muted/50">
                          <div className="flex justify-between items-start">
                            <div>
                              <p className="font-medium">{tt?.name ?? ''}</p>
                              <p className="text-xs text-muted-foreground">{tt?.phaseName ?? ''}</p>
                            </div>
                            <p className="font-bold text-primary">{(tt?.price ?? 0).toFixed(2)}€</p>
                          </div>
                          {soldOut && <Badge variant="destructive" className="mt-2 text-xs">Agotado</Badge>}
                        </div>
                      );
                    })}
                  </div>
                  {spotsLeft > 0 && (event?.ticketTypes?.length ?? 0) > 0 && (
                    <Link href={`/eventos/${event?.slug ?? ''}/comprar`}>
                      <Button className="w-full mt-4 gap-2 font-display font-semibold rounded-full shadow-lg shadow-primary/25" size="lg">
                        <Ticket className="h-5 w-5" /> ¡Comprar Entradas!
                      </Button>
                    </Link>
                  )}
                </CardContent></Card>
              </div>
            </SlideIn>
          </div>
        </div>
      </div>
    </Container>
  );
}
