import { absoluteUrl } from '@/lib/seo/json-ld';

/* JSON-LD de un evento (Schema.org/Event): lo que usan los buscadores para enseñar la fecha, el lugar y el precio en el resultado. Puro.
 * Solo cuenta lo que la ficha ya muestra: nada inventado (si falta un dato, el campo no se emite). */

export type EventLdInput = {
  name: string;
  slug: string;
  description?: string | null;
  venue: string;
  city: string;
  address?: string | null;
  imageUrl?: string | null;
  date: Date | string;
  /** Solo las entradas activas de la ficha. */
  ticketTypes: readonly { name: string; price: number; maxQuantity: number; soldCount: number }[];
  /** Venta online cerrada: solo se vende en taquilla. */
  onlineSalesClosed?: boolean;
  /** El evento ya pasó: la ficha no vende, así que no se anuncia ninguna oferta (el buscador no debe mostrar «comprar» de algo que ya ocurrió). */
  ended?: boolean;
};

const AVAILABILITY = {
  inStock: 'https://schema.org/InStock',
  soldOut: 'https://schema.org/SoldOut',
  inStore: 'https://schema.org/InStoreOnly',
} as const;

export function eventJsonLd(e: EventLdInput, organizerName: string, baseUrl: string): Record<string, unknown> | null {
  const start = new Date(e.date);
  if (Number.isNaN(start.getTime())) return null; // sin fecha válida no hay evento que describir
  const url = absoluteUrl(`/eventos/${e.slug}`, baseUrl);
  const description = (e.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const address = (e.address ?? '').trim();

  const offers = (e.ended ? [] : e.ticketTypes).map((t) => {
    const soldOut = t.maxQuantity - t.soldCount <= 0;
    return {
      '@type': 'Offer',
      name: t.name,
      price: t.price.toFixed(2),
      priceCurrency: 'EUR',
      availability: e.onlineSalesClosed ? AVAILABILITY.inStore : soldOut ? AVAILABILITY.soldOut : AVAILABILITY.inStock,
      // En un evento «solo en taquilla» no hay compra online a la que apuntar.
      ...(e.onlineSalesClosed || !baseUrl ? {} : { url: absoluteUrl(`/eventos/${e.slug}/comprar`, baseUrl) }),
    };
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: e.name,
    startDate: start.toISOString(),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: e.venue,
      address: { '@type': 'PostalAddress', addressLocality: e.city, ...(address ? { streetAddress: address } : {}) },
    },
    ...(description ? { description } : {}),
    ...(e.imageUrl ? { image: [absoluteUrl(e.imageUrl, baseUrl)] } : {}),
    ...(offers.length > 0 ? { offers } : {}),
    organizer: { '@type': 'Organization', name: organizerName },
    ...(baseUrl ? { url } : {}),
  };
}
