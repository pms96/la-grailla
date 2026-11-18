/* Qué se devuelve del pedido al comprador que lo consulta con su enlace (H-211). `GET /api/orders/[orderId]` y `/api/shop/orders/[orderId]` devolvían la fila entera:
 * `notes` (en la tienda es un campo INTERNO que escribe el admin), `soldById`, `idempotencyKey`, `paymentId`, `pdfUrl` y los contadores de la cola de reconciliación.
 * El comprador solo necesita saber SI hubo un pago (`hasPayment`): con él la pantalla decide entre «no se ha cobrado» y «estamos comprobando». */

const INTERNAL_COMMON = ['idempotencyKey', 'paymentId', 'reconcileCheckedAt', 'reconcileAttempts'] as const;

export const INTERNAL_ORDER_FIELDS: readonly string[] = [...INTERNAL_COMMON, 'soldById', 'pdfUrl', 'emailLastError'];
export const INTERNAL_SHOP_ORDER_FIELDS: readonly string[] = [...INTERNAL_COMMON, 'notes'];

/** El pedido sin los campos internos y con `hasPayment` (¿tiene un pago asociado en la pasarela?). */
export function publicOrder<T extends { paymentId?: string | null }>(order: T, internal: readonly string[]): Record<string, unknown> & { hasPayment: boolean } {
  const out: Record<string, unknown> = { ...order };
  for (const key of internal) delete out[key];
  return { ...out, hasPayment: Boolean(order.paymentId) };
}
