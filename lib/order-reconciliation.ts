import { prisma } from '@/lib/prisma';

/* Reconciliación de pedidos cuando solo se conoce su id (webhooks de cobro): decide a qué módulo pertenece y delega. La lógica de cada
 * módulo vive en lib/reconciliation/{entradas,tienda}.ts y se carga solo cuando hace falta: confirmar un pedido de la tienda no importa
 * nada de entradas (PDF, wallet, aforo) y al revés. */

/** Resuelve si el orderId del metadata de la pasarela es pedido de entradas o de tienda. */
export async function resolvePaidCheckout(orderId: string, baseUrl?: string): Promise<'ticket' | 'shop' | null> {
  if (await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } })) {
    const { completeOrder } = await import('@/lib/reconciliation/entradas');
    await completeOrder(orderId, baseUrl);
    return 'ticket';
  }
  if (await prisma.shopOrder.findUnique({ where: { id: orderId }, select: { id: true } })) {
    const { completeShopOrder } = await import('@/lib/reconciliation/tienda');
    await completeShopOrder(orderId);
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
