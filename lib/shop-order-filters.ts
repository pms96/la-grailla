import type { Prisma, ShopOrderStatus } from '@prisma/client';

const SHOP_ORDER_STATUSES: ShopOrderStatus[] = ['PENDING', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];

export type ShopOrdersFilterParams = {
  q?: string;
  status?: string;
};

// Mismo patrón que lib/order-filters.ts (Ventas) — Fase 6 del plan de
// actuación: la tienda sigue activa, así que Pedidos de Tienda necesita el
// mismo buscador/filtro antes de que haya tráfico real, no después.
export function buildShopOrdersWhere(params: ShopOrdersFilterParams): Prisma.ShopOrderWhereInput {
  const q = (params.q ?? '').trim();
  const status = SHOP_ORDER_STATUSES.includes(params.status as ShopOrderStatus)
    ? (params.status as ShopOrderStatus)
    : undefined;

  return {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { buyerEmail: { contains: q, mode: 'insensitive' } },
            { buyerName: { contains: q, mode: 'insensitive' } },
            { id: { contains: q, mode: 'insensitive' } },
            { trackingNumber: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}
