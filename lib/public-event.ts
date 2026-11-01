/** Campos de gestión interna de un evento: nunca salen en la API pública. */
const INTERNAL_EVENT_FIELDS = ['alertsSent', 'alertThresholds', 'alertAt80', 'alertAt95', 'temporadaId', 'archivado'] as const;

type InternalField = (typeof INTERNAL_EVENT_FIELDS)[number];

/** Devuelve el evento sin los umbrales y avisos de aforo ni el vínculo con la temporada (Contabilidad). */
export function toPublicEvent<T extends Record<string, unknown>>(event: T): Omit<T, InternalField> {
  const copy: Record<string, unknown> = { ...event };
  for (const key of INTERNAL_EVENT_FIELDS) delete copy[key];
  return copy as Omit<T, InternalField>;
}

/**
 * ¿Puede verse la ficha pública de este evento? Un borrador solo lo ve quien puede gestionarlo (ADMIN con Entradas): antes `/eventos/[slug]` y el PDF de
 * autorización de menores lo servían por slug —cartel, fecha, lugar y precios antes del anuncio—, mientras `/api/events*` y `/comprar` ya lo escondían (H-059).
 * Finalizado y cancelado siguen visibles (con su aviso): son eventos ya anunciados.
 */
export function isEventPageVisible(status: string, viewerCanSeeDrafts: boolean): boolean {
  return status !== 'DRAFT' || viewerCanSeeDrafts;
}
