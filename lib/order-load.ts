/* H-220: qué significa una respuesta de `GET /api/orders/[id]` o `/api/shop/orders/[id]` para la pantalla de confirmación. Solo un 4xx de «no existe o no es tuyo» justifica
 * «Pedido no encontrado»; un 429 o un 5xx es un fallo transitorio: quien acaba de pagar no debe creer que su pedido se perdió, y una confirmación ya pintada no se sustituye por un error. */

export type OrderLoadOutcome = 'ok' | 'not_found' | 'transient';

export function orderLoadOutcome(status: number): OrderLoadOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 408 || status === 425 || status === 429) return 'transient';
  if (status >= 400 && status < 500) return 'not_found';
  return 'transient'; // 5xx, o 0 / desconocido
}
