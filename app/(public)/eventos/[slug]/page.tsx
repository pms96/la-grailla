import { prisma, type EventWithAvailability } from '@/lib/prisma';
import { blobImgProps, IMG_SIZES } from '@/lib/images/blob-image';
import { notFound } from 'next/navigation';
import { hasEventEnded } from '@/lib/active-event';
import { getEventAvailability, ISSUED_TICKETS_COUNT } from '@/lib/ticket-availability';
import { getEventAgeWarningMessage } from '@/lib/age-warning';
import { getOnlineSalesClosedLabel, getOnlineSalesClosedMessage } from '@/lib/online-sales-closed';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, MapPin, Clock, Users, ShieldCheck, Ticket, AlertTriangle, Music, Store } from 'lucide-react';
import { FadeIn, SlideIn } from '@/components/ui/animate';
import { Container } from '@/components/layouts/container';
import { MobileBuyBar } from './_components/mobile-buy-bar';
import { MapFacade } from './_components/map-facade';
import { AgeWarningGate } from './_components/age-warning-gate';
import { ReloadButton } from '@/components/reload-button';
import { absoluteBrandUrl, getBrand } from '@/lib/brand/brand';
import { PageBanner, hasBanner } from '../../_templates/page-banner';
import { canonicalAlternates, siteBaseUrl } from '@/lib/seo/canonical';
import { eventJsonLd } from '@/lib/seo/event-json-ld';
import { safeJsonLd } from '@/lib/seo/json-ld';
import { EVENT_TIMEZONE } from '@/lib/event-time';

// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

export async function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const [event, brand] = await Promise.all([prisma.event.findUnique({ where: { slug: params?.slug } }), getBrand()]);
  if (!event) return { title: 'Evento' };
  const description = `${event.name} en ${event.venue}, ${event.city}. Compra tus entradas online.`;
  // El cartel del evento y, si no tiene, la imagen social de la marca: así un evento sin cartel no se comparte sin imagen.
  const image = event.imageUrl || absoluteBrandUrl(brand.ogImage);
  return {
    title: event.name,
    description,
    // El `openGraph` de una página sustituye al de la marca (no se mezclan): se completa aquí entero, y Twitter con la misma imagen.
    openGraph: { type: 'website', siteName: brand.name, locale: 'es_ES', title: event.name, description, ...(image ? { images: [{ url: image }] } : {}) },
    ...(image ? { twitter: { card: 'summary_large_image' as const, title: event.name, description, images: [image] } } : {}),
    ...canonicalAlternates(`/eventos/${event.slug}`),
    // La ficha se abre por URL aunque el evento no esté publicado (borrador, finalizado, cancelado): que no entre en los buscadores.
    ...(event.status !== 'PUBLISHED' ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function EventoDetailPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  let event: EventWithAvailability | null = null;
  let loadError = false;
  try {
    event = await prisma.event.findUnique({
      where: { slug: params?.slug },
      include: {
        ticketTypes: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
        ...ISSUED_TICKETS_COUNT,
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
    ? new Date(event.date).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: EVENT_TIMEZONE })
    : '';
  const mapQuery =
    event?.latitude != null && event?.longitude != null
      ? `${event.latitude},${event.longitude}`
      : [event?.venue, event?.address, event?.city].filter(Boolean).join(', ');
  const artists = (event?.artists ?? '').split(',').map((a) => a?.trim?.()).filter(Boolean);
  const activeTypes = event?.ticketTypes ?? [];
  // Estado de venta y «Desde» a partir de lo vendido por tipo activo, igual que el listado y las portadas (no de los escaneos en puerta).
  const { level: demand, soldOut, fromPrice: minPrice } = getEventAvailability(activeTypes, event?.maxCapacity, event?._count?.tickets);
  const taquillaOnly = Boolean(event?.onlineSalesClosed);
  const taquillaOnlyLabel = getOnlineSalesClosedLabel(event ?? { onlineSalesClosed: false });
  const taquillaOnlyMessage = getOnlineSalesClosedMessage(event ?? { onlineSalesClosed: false });
  const eventEnded = hasEventEnded(event?.date, event?.endTime);
  // Cancelado por el organizador (P1-04): sin botón de compra y con un aviso claro; la venta ya está cerrada en el servidor.
  const eventCancelled = event?.status === 'CANCELLED';
  const ageWarningMessage = getEventAgeWarningMessage(event ?? { ageWarningEnabled: false });

  // Todas las plantillas llevan su propia cabecera salvo Feria, que conserva la de siempre (la de La Grailla).
  const brand = await getBrand();
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const banner = hasBanner(brand.template) ? (
    <PageBanner
      template={brand.template}
      brandName={brand.name}
      title={event?.name ?? ''}
      imageUrl={event?.imageUrl}
      seed={event?.slug}
      italicAccent={brand.theme?.fonts.display === 'instrument-serif'}
      facts={[
        { label: 'Fecha', value: capital(dateStr) },
        { label: 'Horario', value: [event?.doorsOpen, event?.endTime].filter(Boolean).join(' — ') },
        { label: 'Lugar', value: [event?.venue, event?.city].filter(Boolean).join(', ') },
        { label: 'Edad mínima', value: `+${event?.minAge ?? 18}` },
      ].filter((f) => f.value)}
    />
  ) : null;

  // Datos estructurados solo de eventos publicados (los demás llevan `noindex`).
  const eventLd =
    event.status === 'PUBLISHED'
      ? eventJsonLd(
          {
            name: event.name,
            slug: event.slug,
            description: event.description,
            venue: event.venue,
            city: event.city,
            address: event.address,
            imageUrl: event.imageUrl,
            date: event.date,
            ticketTypes: activeTypes.map((t) => ({ name: t.name, price: Number(t.price), maxQuantity: t.maxQuantity, soldCount: t.soldCount })),
            onlineSalesClosed: taquillaOnly,
            ended: eventEnded,
          },
          brand.name,
          siteBaseUrl(),
        )
      : null;

  const ticketsCard = (
    <Card id="entradas">
      <CardContent className="p-6">
        <h2 className="font-display font-bold text-lg mb-1 flex items-center gap-2">
          <Ticket className="h-5 w-5 text-primary" /> Entradas
        </h2>
        <p className="text-sm text-muted-foreground mb-4 flex items-center gap-1">
          <Users className="h-3.5 w-3.5" />
          {eventCancelled
            ? <span className="text-destructive-text font-medium">Evento cancelado</span>
            : eventEnded
            ? 'Evento finalizado'
            : taquillaOnly
            ? <span className="text-warm-yellow font-medium">{taquillaOnlyLabel}</span>
            : demand === 'sold_out'
            ? 'Sin plazas online'
            : demand === 'high'
            ? <span className="text-warm-yellow font-medium">Alta demanda</span>
            : 'Plazas disponibles'}
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
        {eventCancelled && (
          <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="status">
            Este evento se ha cancelado y ya no se venden entradas. Quien ya compró recibe un aviso por email con lo que pasa con su pedido.
          </p>
        )}
        {!soldOut && !taquillaOnly && !eventEnded && !eventCancelled && (
          <div className="hidden lg:block">
            <AgeWarningGate
              href={`/eventos/${event?.slug ?? ''}/comprar`}
              warningMessage={ageWarningMessage}
              size="lg"
              className="w-full mt-4 gap-2 font-display font-semibold rounded-full shadow-lg shadow-primary/25"
            >
              <Ticket className="h-5 w-5" /> Comprar entradas
            </AgeWarningGate>
          </div>
        )}
        {taquillaOnly && !eventEnded && !eventCancelled && (
          <div className="hidden lg:flex items-start gap-2 mt-4 rounded-lg border border-warm-yellow/30 bg-warm-yellow/5 p-3 text-sm text-muted-foreground">
            <Store className="h-4 w-4 text-warm-yellow shrink-0 mt-0.5" />
            <span>{taquillaOnlyMessage}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <>
      {eventLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(eventLd) }} />}
      {banner ?? (
      /* Cartel full-bleed — mismo lenguaje visual que el hero de home */
      <div className="relative overflow-hidden min-h-[42vh] md:min-h-[48vh] flex items-end">
        {event?.imageUrl ? (
          <>
            <img
              {...blobImgProps(event.imageUrl, { sizes: IMG_SIZES.full })}
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
              {(event?.doorsOpen || event?.endTime) && (
                <Badge variant="secondary" className="gap-1">
                  <Clock className="h-3 w-3" /> {[event?.doorsOpen, event?.endTime].filter(Boolean).join(' — ')}
                </Badge>
              )}
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
      )}

      <Container size={banner ? 'xl' : 'lg'}>
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

              {event?.minorAuthorizationEnabled && (
                <SlideIn from="left" delay={0.35}>
                  <Card>
                    <CardContent className="p-6">
                      <h2 className="font-display font-bold text-lg mb-3 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-warm-yellow" /> Menores de 16 y 17 años
                      </h2>
                      <p className="text-muted-foreground text-sm">
                        Si el asistente tiene 16 o 17 años, deberá presentar en taquilla esta autorización rellena y
                        firmada por su padre/madre/tutor.
                      </p>
                      <a
                        href={`/api/events/${event.slug}/minor-authorization`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                      >
                        Descargar autorización de menores (PDF)
                      </a>
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
                          <MapFacade query={mapQuery} venue={event?.venue ?? 'la sala'} />
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
        taquillaOnly={taquillaOnly}
        taquillaOnlyLabel={taquillaOnlyLabel}
        ended={eventEnded}
        cancelled={eventCancelled}
        ageWarningMessage={ageWarningMessage}
      />
    </>
  );
}
