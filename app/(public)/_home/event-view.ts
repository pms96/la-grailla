import { getEventDemandLevel } from '@/lib/ticket-availability';
import { getOnlineSalesClosedLabel } from '@/lib/online-sales-closed';

/* Lo que las plantillas de portada nuevas (marquesina, galería…) necesitan de un evento, ya formateado en el servidor (las fechas son de
 * Madrid, como las entradas y los pases de wallet: un evento a las 00:30 no puede aparecer el día anterior). Módulo puro, sin React. */

const TZ = 'Europe/Madrid';

export type TemplateEvent = {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  /** «sáb», «14», «nov». */
  weekday: string;
  day: string;
  month: string;
  /** «sábado, 14 de noviembre». */
  longDate: string;
  place: string;
  fromPrice: number | null;
  /** Estado de venta a mostrar en la fila; null = venta normal. */
  status: string | null;
};

/** Lo mínimo que se lee de un evento (compatible con `EventWithTicketTypes`). */
export type EventInput = {
  id: string;
  slug: string;
  name: string;
  imageUrl?: string | null;
  date: Date | string;
  venue?: string | null;
  city?: string | null;
  maxCapacity?: number | null;
  currentCount?: number | null;
  onlineSalesClosed?: boolean | null;
  onlineSalesClosedLabel?: string | null;
  ticketTypes?: readonly { price: number }[] | null;
};

const strip = (s: string) => s.replace(/\./g, '');

export function toTemplateEvent(e: EventInput): TemplateEvent {
  const d = new Date(e.date);
  const fmt = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('es-ES', { timeZone: TZ, ...o });
  const demand = getEventDemandLevel(e.maxCapacity ?? 0, e.currentCount ?? 0);
  const closed = getOnlineSalesClosedLabel({ onlineSalesClosed: e.onlineSalesClosed ?? false, onlineSalesClosedLabel: e.onlineSalesClosedLabel ?? null });
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    imageUrl: e.imageUrl ?? null,
    weekday: strip(fmt({ weekday: 'short' })),
    day: fmt({ day: 'numeric' }),
    month: strip(fmt({ month: 'short' })),
    longDate: fmt({ weekday: 'long', day: 'numeric', month: 'long' }),
    place: [e.venue, e.city].filter(Boolean).join(', '),
    fromPrice: e.ticketTypes?.[0]?.price ?? null,
    status: closed ?? (demand === 'sold_out' ? 'Sin plazas online' : demand === 'high' ? 'Alta demanda' : null),
  };
}

/**
 * Tamaño del titular según su longitud: un nombre largo a 17vw se saldría de la pantalla. Cuenta también la palabra MÁS LARGA, porque una
 * palabra no se parte: «Merchandising» ocupa lo mismo en una línea de 13 letras que en un titular de 13 letras, y la máscara por palabras la
 * recortaría si no cabe. `wide`: tipografías anchas (la de «tipo», Montserrat pesada), que necesitan un tamaño menor para la misma palabra.
 */
export function titleSize(text: string, wide = false): 'l' | 'm' | 's' {
  const clean = text.trim();
  const longestWord = clean.split(/\s+/).reduce((max, w) => Math.max(max, w.length), 0);
  const [toSmall, toMedium] = wide ? [10, 7] : [13, 10];
  if (clean.length > 28 || longestWord >= toSmall) return 's';
  if (clean.length > 14 || longestWord >= toMedium) return 'm';
  return 'l';
}
