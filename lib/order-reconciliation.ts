import { prisma } from '@/lib/prisma';
import type { CompleteOutcome, PaidInfo } from '@/lib/reconciliation/shared';

/* Reconciliación de pedidos cuando solo se conoce su id (webhooks de cobro): decide a qué módulo pertenece y delega. La lógica de cada
 * módulo vive en lib/reconciliation/{entradas,tienda}.ts y se carga solo cuando hace falta: confirmar un pedido de la tienda no importa
 * nada de entradas (PDF, wallet, aforo) y al revés. */

/** Un pago tardío que no se ha podido resolver (reembolso fallido, pago no comprobable) hace fallar el webhook: la pasarela reintenta y, como el evento no se marca como procesado (PAY-05), el reintento vuelve a intentarlo. */
class LatePaymentUnresolvedError extends Error {
  constructor(orderId: string) {
    super(`Pago tardío del pedido ${orderId} sin resolver (ver [late-payment] en los logs); se reintentará`);
    this.name = 'LatePaymentUnresolvedError';
  }
}
const assertResolved = (orderId: string, outcome: CompleteOutcome) => {
  if (outcome === 'late_unresolved') throw new LatePaymentUnresolvedError(orderId);
};

/** Resuelve si el orderId del metadata de la pasarela es pedido de entradas o de tienda. */
/** `paid`: lo que la pasarela dice haber cobrado, si el webhook lo trae; se contrasta con el total del pedido antes de completarlo (P1-07). */
export async function resolvePaidCheckout(orderId: string, baseUrl?: string, paid?: PaidInfo): Promise<'ticket' | 'shop' | null> {
  if (await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } })) {
    const { completeOrder } = await import('@/lib/reconciliation/entradas');
    assertResolved(orderId, await completeOrder(orderId, baseUrl, paid));
    return 'ticket';
  }
  if (await prisma.shopOrder.findUnique({ where: { id: orderId }, select: { id: true } })) {
    const { completeShopOrder } = await import('@/lib/reconciliation/tienda');
    assertResolved(orderId, await completeShopOrder(orderId, paid, { baseUrl }));
    return 'shop';
  }
  return null;
}

export async function resolveExpiredCheckout(orderId: string): Promise<'ticket' | 'shop' | null> {
  if (await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } })) {
    const { releaseExpiredOrder } = await import('@/lib/reconciliation/entradas');
    await releaseExpiredOrder(orderId);
    return 'ticket';
  }
  if (await prisma.shopOrder.findUnique({ where: { id: orderId }, select: { id: true } })) {
    const { releaseExpiredShopOrder } = await import('@/lib/reconciliation/tienda');
    await releaseExpiredShopOrder(orderId);
    return 'shop';
  }
  return null;
}
