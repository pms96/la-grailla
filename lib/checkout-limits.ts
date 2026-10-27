/* Topes de una compra (P0-04). Viven en el SERVIDOR (la UI solo los refleja): sin ellos, un script llamando a la API a mano podía pedir lo que
 * quisiera y dejar el aforo/stock retenido sin pagar. Una sola definición, compartida por el formulario y por las rutas. */

/** Entradas de un mismo tipo en un pedido (el tope que ya tenía el formulario). */
export const MAX_TICKETS_PER_TYPE = 10;
/** Tipos de entrada distintos en un pedido. */
export const MAX_TICKET_LINES_PER_ORDER = 20;

/** Tienda: líneas distintas, unidades por línea y unidades en total por pedido. */
export const MAX_SHOP_LINES_PER_ORDER = 20;
export const MAX_SHOP_UNITS_PER_LINE = 10;
export const MAX_SHOP_UNITS_PER_ORDER = 30;

/**
 * Pedidos sin pagar a la vez que puede tener una misma IP (por evento en entradas; en total en tienda): valor POR DEFECTO, configurable por
 * cliente (`orders_max_pending_per_ip` y `shop_orders_max_pending_per_ip`, como `orders_rate_limit_per_ip`). Es un freno contra scripts que
 * desde UNA sola IP acaparan aforo/stock sin pagar; NO es una defensa completa (rotando IP o con IPv6 se evade; falta captcha, que
 * necesita claves del dueño). Por eso el valor por defecto es holgado: una wifi de recinto o una red móvil con CGNAT comparte IP entre
 * muchos compradores legítimos. El hueco se libera al pagar, al abandonar por `cancelUrl`, al anular desde el admin y, en todo caso, a los 40 min.
 */
export const MAX_PENDING_ORDERS_PER_IP = 10;
export const PENDING_LIMIT_CONFIG_KEY = { entradas: 'orders_max_pending_per_ip', tienda: 'shop_orders_max_pending_per_ip' } as const;

/** Valor de la configuración (texto) → tope efectivo: vacío o inválido = el de por defecto. */
export function parsePendingLimit(raw: string | null | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n >= 1 ? n : MAX_PENDING_ORDERS_PER_IP;
}

/**
 * Email para CONTAR compras de una misma persona: minúsculas y sin el sufijo `+alias` (`ana+1@gmail.com` y `ana+2@gmail.com` son la misma
 * persona). No toca los puntos: en otros proveedores sí distinguen buzones. Para mostrar o escribir se usa siempre el email original.
 */
export function normalizeEmailForLimit(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;
  const local = lower.slice(0, at).split('+')[0];
  return `${local || lower.slice(0, at)}${lower.slice(at)}`;
}
