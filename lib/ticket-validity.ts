/* ¿Sigue siendo VÁLIDA una entrada? Una única regla para el escáner, el PDF, los pases de Wallet y cualquier otra superficie que enseñe o acepte un QR
 * (auditoría P1-02 / EN-05 / EN-13). Función pura: se decide por el estado del PEDIDO y del EVENTO, no solo por el de la entrada, porque la entrada
 * puede seguir en VALID cuando el pedido ya no vale (reembolso hecho desde el panel de la pasarela, o un proceso que murió a medias al anular).
 *
 * Solo un pedido COMPLETED tiene entradas utilizables, y un evento CANCELLED no tiene ninguna. El resto de estados del evento no bloquean: un
 * evento FINISHED o la fecha ya pasada no impiden validar una entrada (el personal puede cerrar el evento antes que la puerta). */

export type TicketUnusableReason = 'order_pending' | 'order_cancelled' | 'order_refunded' | 'event_cancelled';

export interface TicketUnusable {
  reason: TicketUnusableReason;
  /** Para el personal en la puerta (corto, en mayúsculas al estilo del escáner). */
  scanMessage: string;
  /** Para el comprador que abre su PDF o su pase. */
  buyerMessage: string;
}

const MESSAGES: Record<TicketUnusableReason, Omit<TicketUnusable, 'reason'>> = {
  order_pending: {
    scanMessage: 'PAGO NO CONFIRMADO — Entrada no válida todavía',
    buyerMessage: 'El pago de este pedido todavía no está confirmado, así que las entradas aún no son válidas.',
  },
  order_cancelled: {
    scanMessage: 'ENTRADA NO VÁLIDA — Pedido anulado',
    buyerMessage: 'Este pedido está anulado: sus entradas ya no son válidas.',
  },
  order_refunded: {
    scanMessage: 'ENTRADA NO VÁLIDA — Pedido reembolsado',
    buyerMessage: 'Este pedido fue reembolsado: sus entradas ya no son válidas.',
  },
  event_cancelled: {
    scanMessage: 'EVENTO CANCELADO — Entrada no válida',
    buyerMessage: 'El evento se ha cancelado: estas entradas ya no son válidas.',
  },
};

/** Motivo por el que las entradas de este pedido/evento no valen, o null si valen. Un estado desconocido se trata como NO válido (falla cerrado). */
export function ticketUnusable(
  order: { status?: string | null } | null | undefined,
  event: { status?: string | null } | null | undefined
): TicketUnusable | null {
  let reason: TicketUnusableReason | null = null;
  switch (order?.status) {
    case 'COMPLETED':
      break;
    case 'PENDING':
      reason = 'order_pending';
      break;
    case 'REFUNDED':
      reason = 'order_refunded';
      break;
    default:
      reason = 'order_cancelled'; // CANCELLED, y cualquier valor que no conozcamos
  }
  if (!reason && event?.status === 'CANCELLED') reason = 'event_cancelled';
  return reason ? { reason, ...MESSAGES[reason] } : null;
}
