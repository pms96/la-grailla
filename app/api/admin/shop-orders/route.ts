export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { buildShopOrdersWhere } from '@/lib/shop-order-filters';
import { withoutSeasonLink } from '@/lib/modules/season-link';
import { getEmailStates } from '@/lib/email-delivery';
import { adminEmailView } from '@/lib/order-email';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const where = buildShopOrdersWhere({
      q: searchParams.get('q') ?? '',
      status: searchParams.get('status') ?? '',
    });
    const orders = await prisma.shopOrder.findMany({
      where,
      include: { items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // Estado real del email de cada pedido (una sola consulta a los marcadores de envío).
    const states = await getEmailStates('tienda', orders.map((o) => o.id));
    return NextResponse.json(withoutSeasonLink((orders ?? []).map((o) => ({ ...o, emailDelivery: adminEmailView(states.get(o.id)) }))));
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/shop-orders');
  }
}
