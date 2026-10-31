export type EventDemandLevel = 'sold_out' | 'high' | 'normal';

/** Lo que se lee de un tipo de entrada: precio, tope de venta y entradas ya vendidas (`TicketType.soldCount`, lo que sube al comprar). */
export type AvailabilityTicketType = {
  price: number;
  maxQuantity: number;
  soldCount: number;
  /** Ausente = activo (las consultas públicas ya traen solo los activos). */
  isActive?: boolean;
};

export type EventAvailability = {
  level: EventDemandLevel;
  /** Ningún tipo activo con plazas (o aforo completo): no se puede comprar online. Sin tipos activos también cuenta como agotado. */
  soldOut: boolean;
  /** Precio mínimo entre los tipos activos con plazas («Desde X €»); null si no queda ninguno. */
  fromPrice: number | null;
};

/** Fragmento de `include` de Prisma para que una página pública traiga las entradas emitidas del evento (`_count.tickets`) y se las pase a `getEventAvailability`. */
export const ISSUED_TICKETS_COUNT = {
  _count: { select: { tickets: { where: { status: { notIn: ['CANCELLED', 'REFUNDED'] as ('CANCELLED' | 'REFUNDED')[] } } } } },
} as const;

const HIGH_DEMAND_MAX_LEFT = 50;
const HIGH_DEMAND_MAX_RATIO = 0.2;

/**
 * Disponibilidad PÚBLICA de un evento a partir de lo VENDIDO, no de lo escaneado en puerta (`Event.currentCount` solo sube al entrar y vale 0
 * hasta la noche del evento: con él nunca se marcaba «agotado» antes). Entradas que quedan = Σ(maxQuantity − soldCount) de los tipos activos,
 * y si hay aforo (`maxCapacity`) no pueden pasar de aforo − vendidas: así lo comprueba también `/api/orders` (que cuenta las emitidas de
 * verdad; aquí solo se ven las de los tipos pasados, un suelo, de modo que nunca se marca agotado un evento con plazas). Solo se da un nivel
 * cualitativo, nunca las plazas restantes ni el aforo: no se dan pistas de cuánto queda por vender.
 */
export function getEventAvailability(
  ticketTypes: readonly AvailabilityTicketType[] | null | undefined,
  maxCapacity?: number | null,
  // H-078: entradas EMITIDAS del evento (no anuladas ni reembolsadas), incluidas las de invitaciones, que no tienen tipo y por tanto no suben
  // `soldCount` pero ocupan aforo igual. Es lo que cuenta el checkout; sin él, la suma por tipo anunciaba plazas que luego daban «Aforo completo».
  issuedCount?: number | null
): EventAvailability {
  const active = (ticketTypes ?? []).filter((t) => t.isActive !== false);
  const left = (t: AvailabilityTicketType) => Math.max(0, (t.maxQuantity ?? 0) - (t.soldCount ?? 0));
  const withStock = active.filter((t) => left(t) > 0);

  let remaining = withStock.reduce((sum, t) => sum + left(t), 0);
  let offered = active.reduce((sum, t) => sum + Math.max(0, t.maxQuantity ?? 0), 0);
  if (maxCapacity != null && maxCapacity > 0) {
    const soldByType = active.reduce((sum, t) => sum + Math.max(0, t.soldCount ?? 0), 0);
    const sold = issuedCount != null ? Math.max(0, issuedCount) : soldByType;
    remaining = Math.min(remaining, Math.max(0, maxCapacity - sold));
    offered = Math.min(offered, maxCapacity);
  }

  if (remaining <= 0) return { level: 'sold_out', soldOut: true, fromPrice: null };
  const high = remaining <= HIGH_DEMAND_MAX_LEFT && offered > 0 && remaining / offered <= HIGH_DEMAND_MAX_RATIO;
  return { level: high ? 'high' : 'normal', soldOut: false, fromPrice: Math.min(...withStock.map((t) => t.price)) };
}
