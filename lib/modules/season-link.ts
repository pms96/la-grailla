import { isModuleEnabled } from '@/lib/modules/runtime';

/* El vínculo de eventos, productos, pedidos de tienda y patrocinios con una Temporada es de CONTABILIDAD (la temporada es suya).
 * Sin ese módulo no se ofrece, no se acepta al guardar y no se devuelve el nombre de la temporada: antes Entradas, Tienda y Sponsors
 * leían y escribían ese vínculo igual, y un cliente sin Contabilidad veía y enlazaba temporadas de un módulo que no tiene. */
export function seasonLinkEnabled(): boolean {
  return isModuleEnabled('contabilidad');
}

const SEASON_KEYS = new Set(['temporadaId', 'temporada']);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  // Solo objetos planos: fechas, Decimal y demás instancias se devuelven tal cual.
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !SEASON_KEYS.has(k)).map(([k, v]) => [k, strip(v)]));
  }
  return value;
}

/** Quita `temporadaId` y `temporada` (también anidados) de lo que se devuelve cuando el cliente no tiene Contabilidad. */
export function withoutSeasonLink<T>(value: T): T {
  return seasonLinkEnabled() ? value : (strip(value) as T);
}
