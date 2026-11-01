import { formatMadridLocal, parseMadridLocal } from '@/lib/event-time';

/* Eventos con la fecha posiblemente desfasada (H-073). Antes del arreglo de la zona horaria (P0-02) el formulario del admin guardaba «22:30» como 22:30Z; la
 * web, el email, el PDF y Wallet (todos en Madrid) lo enseñan una o dos horas después (a veces el día siguiente). El instante guardado es perfectamente válido,
 * así que NADA en la base de datos distingue un evento afectado de uno bien puesto: no se puede migrar a ciegas (movería también los que alguien ya corrigió a
 * mano) ni avisar solo. Lo que sí se puede es LISTAR, en solo lectura, los candidatos (creados antes del arreglo y todavía por celebrarse) con la fecha tal como
 * se ve ahora y la que probablemente se quiso, para que el dueño los revise y corrija a mano. Pura: la usa `scripts/listar-eventos-fecha-a-revisar.ts`. */

export type EventForDateReview = {
  id: string;
  name: string;
  slug: string;
  date: Date;
  status: string;
  createdAt: Date;
  /** Pedidos cobrados (COMPLETED): los compradores ya recibieron la fecha antigua. */
  completedOrders: number;
};

export type EventDateReviewRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  date: Date;
  /** Hora de Madrid tal como la ve hoy el público (`YYYY-MM-DDTHH:mm`). */
  savedLocal: string;
  /** Hora de Madrid que probablemente quiso quien lo creó. */
  intendedLocal: string;
  completedOrders: number;
  advice: string;
};

/**
 * La fecha que quiso quien creó el evento: la hora de pared que se guardó como UTC, leída como hora de Madrid. Null si el resultado no es una fecha válida
 * (no pasa con fechas reales).
 */
export function intendedDateOfLegacyEvent(saved: Date): Date | null {
  return parseMadridLocal(saved.toISOString().slice(0, 16));
}

/** Eventos candidatos a revisar: creados antes del despliegue del arreglo, por celebrarse y que no estén cancelados ni terminados. Ordenados por fecha. */
export function eventsNeedingDateReview(events: readonly EventForDateReview[], opts: { createdBefore: Date; now: Date }): EventDateReviewRow[] {
  return events
    .filter((e) => e.createdAt < opts.createdBefore && e.date.getTime() > opts.now.getTime() && e.status !== 'CANCELLED' && e.status !== 'FINISHED')
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((e) => {
      const intended = intendedDateOfLegacyEvent(e.date);
      return {
        id: e.id,
        name: e.name,
        slug: e.slug,
        status: e.status,
        date: e.date,
        savedLocal: formatMadridLocal(e.date),
        intendedLocal: formatMadridLocal(intended),
        completedOrders: e.completedOrders,
        advice:
          e.completedOrders > 0
            ? `Tiene ${e.completedOrders} pedido${e.completedOrders === 1 ? '' : 's'} cobrado${e.completedOrders === 1 ? '' : 's'}: al corregir la fecha el panel preguntará si hay que avisar a los compradores por email. Decide antes qué hora han visto ellos.`
            : 'Sin pedidos: se puede corregir la fecha directamente desde el panel.',
      };
    });
}
