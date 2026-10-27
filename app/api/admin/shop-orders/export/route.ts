export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { buildShopOrdersWhere } from '@/lib/shop-order-filters';
import { SHOP_ORDERS_CSV_MAX, madridDay, shopOrdersToCsv } from '@/lib/shop-orders-csv';

// Cuelga de /api/admin/shop-orders: mismo módulo (tienda) y por tanto el mismo permiso por rol que el listado de pedidos.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    // Mismos filtros que el listado en pantalla: el CSV es lo que el admin está viendo.
    const where = buildShopOrdersWhere({
      q: searchParams.get('q') ?? '',
      status: searchParams.get('status') ?? '',
    });
    // Sin truncado silencioso: si no cabe, se avisa y se pide filtrar.
    const total = await prisma.shopOrder.count({ where });
    if (total > SHOP_ORDERS_CSV_MAX) {
      return NextResponse.json(
        { error: `Hay ${total} pedidos con este filtro y el máximo por exportación es ${SHOP_ORDERS_CSV_MAX}. Filtra por estado o búsqueda y vuelve a exportar.` },
        { status: 413 }
      );
    }
    const orders = await prisma.shopOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { items: { orderBy: { id: 'asc' }, include: { product: { select: { name: true } } } } },
    });
    return new NextResponse(shopOrdersToCsv(orders), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pedidos-tienda-${madridDay(new Date())}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/shop-orders/export');
  }
}
