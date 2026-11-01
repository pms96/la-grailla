/* Estado de venta de la ficha pública de un evento (H-156). La ficha y la barra de compra del móvil decidían por separado, con cuatro booleanos, si se enseña el
 * botón «Comprar»: una condición olvidada (`!cancelled`) devolvía el botón en un evento anulado. Aquí hay UNA sola decisión, con prioridad explícita:
 * cancelado > finalizado > solo taquilla > agotado > abierto. Solo `open` enseña el botón de compra. */

export type EventSaleState = 'cancelled' | 'ended' | 'taquilla_only' | 'sold_out' | 'open';

export function eventSaleState(f: { cancelled: boolean; ended: boolean; taquillaOnly: boolean; soldOut: boolean }): EventSaleState {
  if (f.cancelled) return 'cancelled';
  if (f.ended) return 'ended';
  if (f.taquillaOnly) return 'taquilla_only';
  if (f.soldOut) return 'sold_out';
  return 'open';
}
