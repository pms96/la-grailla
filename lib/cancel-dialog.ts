/* Piezas puras del diálogo de cancelar evento (H-087, H-089). Sin dependencias de servidor: las usa un componente de cliente y sus tests. */

import type { ManualKind } from '@/lib/event-cancellation';

/**
 * Qué hacer con un pedido «a resolver a mano», según POR QUÉ está ahí (H-089). Antes todos llevaban «Ábrelo en Ventas para reembolsarlo desde allí», también un aviso
 * que no salió (donde no hay nada que reembolsar) o una entrada ya usada (donde reembolsar es decisión del organizador).
 */
export function manualAdvice(kind: ManualKind): string {
  switch (kind) {
    case 'refund_failed':
    case 'half_refunded':
      return 'Ábrelo en Ventas para reembolsarlo desde allí.';
    case 'used':
      return 'Decide tú si se le devuelve algo y, si es así, hazlo desde Ventas.';
    case 'mail_failed':
      return 'No hay nada que reembolsar: avísale tú por otra vía.';
  }
}

/** Quién es el comprador de un pedido a resolver a mano, para poder avisarle: «Nombre · email · 20,00 €» (sin dato inventado si falta alguno). */
export function manualWho(item: { buyerName: string; buyerEmail: string; amount: number }): string {
  const euros = `${item.amount.toFixed(2).replace('.', ',')} €`;
  return [item.buyerName.trim(), item.buyerEmail.trim(), item.amount > 0 ? euros : ''].filter(Boolean).join(' · ');
}

/**
 * Guarda de los bucles de «pedir el siguiente lote» (H-087). Cerrar la ventana con «sigue en segundo plano» y reabrir el MISMO evento dejaba vivo el bucle viejo
 * (la ventana está siempre montada y el id coincidía otra vez) y permitía lanzar un segundo en paralelo. Cada bucle recibe un `token`: `cancelAll()` (al cerrar o al
 * cambiar de evento) invalida todos y el bucle viejo se corta en su siguiente comprobación; `begin(id)` devuelve `null` si ya hay uno VIVO para ese evento.
 */
export function createDriveGuard() {
  let generation = 0;
  const active = new Map<string, number>();
  return {
    /** Empieza un bucle para `id`: su token, o `null` si ya hay uno vivo. */
    begin(id: string): number | null {
      const current = active.get(id);
      if (current !== undefined && current === generation) return null;
      active.set(id, generation);
      return generation;
    },
    /** ¿Este bucle sigue siendo el vigente? */
    valid(id: string, token: number): boolean {
      return token === generation && active.get(id) === token;
    },
    /** El bucle terminó (bien o mal): deja de contar como vivo. */
    end(id: string, token: number): void {
      if (active.get(id) === token) active.delete(id);
    },
    /** Se cierra la ventana o cambia el evento: todos los bucles en marcha quedan invalidados. */
    cancelAll(): void {
      generation += 1;
      active.clear();
    },
  };
}
