import { getConfig } from '@/lib/config';
import { businessDayKey, parseJornadaCorte } from '@/lib/ventas-por-dia';

/* Jornada de negocio (P1-15): el día «de caja» de un local que vende de madrugada. Un único cálculo, en hora de Madrid, con una hora de corte que fija el
 * propietario (`jornada_corte_hora`, de 0 a 12; 0 = día natural, el comportamiento de siempre). Ver `businessDayKey` en lib/ventas-por-dia.ts. */

export const JORNADA_CORTE_CONFIG_KEY = 'jornada_corte_hora';

/** Hora de corte configurada. Un valor ilegible o fuera de rango es 0: nunca mueve los números de la caja por un error al escribirlo. */
export async function jornadaCorteHora(): Promise<number> {
  return parseJornadaCorte(await getConfig(JORNADA_CORTE_CONFIG_KEY));
}

/** Jornada de negocio de «ahora» (`YYYY-MM-DD`, Madrid): la fecha que debe proponer un formulario de caja. */
export async function jornadaHoy(now: Date = new Date()): Promise<string> {
  return businessDayKey(now, await jornadaCorteHora());
}
