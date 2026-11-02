/* H-229: lo mismo que H-100 hace en la tienda (`rememberUnconfirmedOrder` en `lib/shop-cart.ts`), para el pedido de ENTRADAS: mientras no conste pagado se recuerda en el navegador y
 * el formulario de compra avisa si el comprador vuelve a empezar. Clave propia (la de la tienda enlaza a /tienda/confirmacion) y con el evento, para no avisar de otro. */

import { UNCONFIRMED_ORDER_KEY, parseUnconfirmedOrder, type UnconfirmedOrder } from '@/lib/confirmation-state';

export const UNCONFIRMED_TICKET_ORDER_KEY = `${UNCONFIRMED_ORDER_KEY}_tickets`;

export type UnconfirmedTicketOrder = UnconfirmedOrder & { eventId?: string };

export function rememberUnconfirmedTicketOrder(orderId: string, token?: string, eventId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    const entry: UnconfirmedTicketOrder = { orderId, ...(token ? { token } : {}), ...(eventId ? { eventId } : {}), at: Date.now() };
    window.localStorage.setItem(UNCONFIRMED_TICKET_ORDER_KEY, JSON.stringify(entry));
  } catch {
    // sin almacenamiento: solo se pierde el aviso del formulario de compra
  }
}

/** El pedido de entradas recordado que sigue vigente (menos de un día), o null. */
export function readUnconfirmedTicketOrder(): UnconfirmedTicketOrder | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(UNCONFIRMED_TICKET_ORDER_KEY);
    const base = parseUnconfirmedOrder(raw, Date.now());
    if (!base) return null;
    const eventId = (JSON.parse(raw as string) as { eventId?: unknown }).eventId;
    return { ...base, ...(typeof eventId === 'string' && eventId ? { eventId } : {}) };
  } catch {
    return null;
  }
}

/** El pedido ya consta pagado (o no era de verdad): se deja de avisar. */
export function clearUnconfirmedTicketOrder(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(UNCONFIRMED_TICKET_ORDER_KEY);
  } catch {
    // ignorar
  }
}
