import type { ShopOrderStatus } from '@prisma/client';

/** Estados de un pedido ya cobrado y todavía en circulación: entre ellos el admin puede avanzar y corregir. */
const AFTER_PAYMENT: ShopOrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

/**
 * ¿Puede el admin cambiar un pedido de tienda de `from` a `to` con el cambio de estado "plano"? (Cancelar y reembolsar no pasan por
 * aquí: tienen su propia lógica de dinero y stock.) Antes se aceptaba cualquier estado: PENDING→SHIPPED sin cobro, PAID→PENDING o
 * resucitar un pedido anulado.
 *  - Sin pagar: solo puede pasar a PAID (cobro comprobado a mano).
 *  - Cobrado: puede moverse entre los estados posteriores al pago, nunca volver a PENDING.
 *  - Anulado o reembolsado: terminal.
 */
export function canChangeShopOrderStatus(from: ShopOrderStatus, to: ShopOrderStatus): boolean {
  if (from === to) return true;
  if (from === 'CANCELLED' || from === 'REFUNDED') return false;
  if (from === 'PENDING') return to === 'PAID';
  return AFTER_PAYMENT.includes(to);
}

/** Con la mercancía ya enviada o entregada, un reembolso devuelve el dinero pero no repone el stock. */
export function refundReturnsStock(statusBeforeRefund: ShopOrderStatus): boolean {
  return statusBeforeRefund !== 'SHIPPED' && statusBeforeRefund !== 'DELIVERED';
}
