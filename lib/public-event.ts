/** Campos de gestión interna de un evento: nunca salen en la API pública. */
const INTERNAL_EVENT_FIELDS = ['alertsSent', 'alertThresholds', 'alertAt80', 'alertAt95', 'temporadaId', 'archivado'] as const;

type InternalField = (typeof INTERNAL_EVENT_FIELDS)[number];

/** Devuelve el evento sin los umbrales y avisos de aforo ni el vínculo con la temporada (Contabilidad). */
export function toPublicEvent<T extends Record<string, unknown>>(event: T): Omit<T, InternalField> {
  const copy: Record<string, unknown> = { ...event };
  for (const key of INTERNAL_EVENT_FIELDS) delete copy[key];
  return copy as Omit<T, InternalField>;
}
