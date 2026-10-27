export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { buildOrdersWhere } from '@/lib/order-filters';
import { getEmailStates } from '@/lib/email-delivery';
import { adminEmailView } from '@/lib/order-email';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const take = Math.min(Number(url.searchParams.get('take') ?? 100) || 100, 200);

    const where = buildOrdersWhere({
      q: url.searchParams.get('q') ?? '',
      status: url.searchParams.get('status') ?? '',
      eventId: url.searchParams.get('eventId') ?? '',
      emailFailed: url.searchParams.get('emailFailed') === '1',
    });

    const orders = await prisma.order.findMany({
      where,
      include: {
        event: { select: { id: true, name: true, date: true } },
        tickets: { select: { id: true, status: true } },
        _count: { select: { tickets: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    // Estado real del email de cada pedido (una sola consulta): enviado / en curso / reintentando / agotado.
    const states = await getEmailStates('entradas', orders.map((o) => o.id));
    return NextResponse.json((orders ?? []).map((o) => ({ ...o, emailDelivery: adminEmailView(states.get(o.id)) })));
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/orders');
  }
}
