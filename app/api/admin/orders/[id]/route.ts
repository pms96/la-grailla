export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { invalidateOrder } from '@/lib/order-reconciliation';

const updateOrderSchema = z.object({
  action: z.enum(['cancel', 'refund']),
});

const orderInclude = {
  event: { select: { id: true, name: true, date: true, venue: true, city: true } },
  tickets: {
    include: { ticketType: { select: { id: true, name: true, price: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  invitation: { select: { id: true, guestName: true, listId: true } },
} as const;

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const order = await prisma.order.findUnique({
      where: { id: params?.id },
      include: orderInclude,
    });
    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }
    return NextResponse.json(order);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/orders/[id]');
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = updateOrderSchema.parse(await request.json());
    const mode = body.action === 'refund' ? 'REFUNDED' : 'CANCELLED';
    const result = await invalidateOrder(params?.id, mode);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }

    const order = await prisma.order.findUnique({
      where: { id: params?.id },
      include: orderInclude,
    });
    return NextResponse.json(order);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/orders/[id]');
  }
}
