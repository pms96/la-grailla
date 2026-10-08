import { prisma } from '@/lib/prisma';

/* Resumen de la tienda para su dashboard (módulo Tienda). Cuenta como venta lo que ya está cobrado y no se ha anulado ni devuelto. */

export const SHOP_REVENUE_STATUSES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;
const TO_SHIP_STATUSES = ['PAID', 'PROCESSING'] as const;
const LOW_STOCK_THRESHOLD = 3;
const TOP_PRODUCTS_WINDOW_DAYS = 90;

export type ShopStats = {
  revenue: number;
  orders: number;
  averageOrder: number;
  toShip: number;
  byStatus: Record<string, number>;
  /** Ventas de los últimos `days` días, un punto por día (YYYY-MM-DD en hora de Madrid), también los días sin ventas. */
  daily: { date: string; revenue: number; orders: number }[];
  topProducts: { productId: string; name: string; units: number; revenue: number }[];
  lowStock: { productId: string; name: string; size: string; color: string; stock: number }[];
  recent: { id: string; buyerName: string; totalAmount: number; status: string; createdAt: string }[];
};

const madridDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d); // YYYY-MM-DD

export async function getShopStats(now: Date = new Date(), days = 30): Promise<ShopStats> {
  const revenueStatuses = [...SHOP_REVENUE_STATUSES];
  const since = new Date(now.getTime() - days * 86_400_000);
  const topSince = new Date(now.getTime() - TOP_PRODUCTS_WINDOW_DAYS * 86_400_000);

  const [grouped, revenueAgg, recentSales, items, lowStock, recent] = await Promise.all([
    prisma.shopOrder.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.shopOrder.aggregate({ where: { status: { in: revenueStatuses } }, _sum: { totalAmount: true }, _count: { _all: true } }),
    prisma.shopOrder.findMany({ where: { status: { in: revenueStatuses }, createdAt: { gte: since } }, select: { createdAt: true, totalAmount: true } }),
    // Agregado en la BD (no se traen filas): el ranking es correcto con cualquier volumen.
    prisma.$queryRaw<{ productId: string; name: string; units: number; revenue: number }[]>`
      SELECT i."productId" AS "productId", p."name" AS "name", SUM(i."quantity")::int AS "units", SUM(i."quantity" * i."unitPrice")::float8 AS "revenue"
      FROM "ShopOrderItem" i
      JOIN "ShopOrder" o ON o."id" = i."shopOrderId"
      JOIN "Product" p ON p."id" = i."productId"
      WHERE o."status"::text = ANY(${revenueStatuses}) AND o."createdAt" >= ${topSince}
      GROUP BY i."productId", p."name"
      ORDER BY "units" DESC, "revenue" DESC
      LIMIT 5`,
    prisma.productVariant.findMany({
      where: { stock: { lte: LOW_STOCK_THRESHOLD }, product: { isActive: true } },
      select: { productId: true, size: true, color: true, stock: true, product: { select: { name: true } } },
      orderBy: { stock: 'asc' },
      take: 8,
    }),
    prisma.shopOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, buyerName: true, totalAmount: true, status: true, createdAt: true } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const g of grouped) byStatus[g.status] = g._count._all;

  // Un cubo por día de Madrid. Se resta en el calendario (no en bloques de 24 h): en los días de cambio horario un día dura 23 o 25 h.
  const buckets = new Map<string, { revenue: number; orders: number }>();
  const [y, m, d] = madridDay(now).split('-').map(Number);
  for (let i = days - 1; i >= 0; i--) buckets.set(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10), { revenue: 0, orders: 0 });
  for (const o of recentSales) {
    const b = buckets.get(madridDay(o.createdAt));
    if (b) {
      b.revenue += Number(o.totalAmount);
      b.orders += 1;
    }
  }

  const revenue = Number(revenueAgg._sum.totalAmount ?? 0);
  const orders = revenueAgg._count._all;
  return {
    revenue,
    orders,
    averageOrder: orders > 0 ? revenue / orders : 0,
    toShip: TO_SHIP_STATUSES.reduce((n, s) => n + (byStatus[s] ?? 0), 0),
    byStatus,
    daily: [...buckets].map(([date, v]) => ({ date, revenue: Math.round(v.revenue * 100) / 100, orders: v.orders })),
    topProducts: items.map((p) => ({ ...p, revenue: Math.round(p.revenue * 100) / 100 })),
    lowStock: lowStock.map((v) => ({ productId: v.productId, name: v.product?.name ?? 'Producto', size: v.size, color: v.color, stock: v.stock })),
    recent: recent.map((o) => ({ id: o.id, buyerName: o.buyerName, totalAmount: Number(o.totalAmount), status: o.status, createdAt: o.createdAt.toISOString() })),
  };
}
