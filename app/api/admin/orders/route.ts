export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const ORDER_STATUSES: OrderStatus[] = ['PENDING', 'COMPLETED', 'CANCELLED', 'REFUNDED'];

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim();
    const statusParam = url.searchParams.get('status') ?? '';
    const eventId = url.searchParams.get('eventId') ?? '';
    const take = Math.min(Number(url.searchParams.get('take') ?? 100) || 100, 200);

    const status = ORDER_STATUSES.includes(statusParam as OrderStatus)
      ? (statusParam as OrderStatus)
      : undefined;

    const where: Prisma.OrderWhereInput = {
      ...(status ? { status } : {}),
      ...(eventId ? { eventId } : {}),
      ...(q
        ? {
            OR: [
              { buyerEmail: { contains: q, mode: 'insensitive' } },
              { buyerName: { contains: q, mode: 'insensitive' } },
              { buyerLastName: { contains: q, mode: 'insensitive' } },
              { id: { contains: q, mode: 'insensitive' } },
              { paymentId: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

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

    return NextResponse.json(orders ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/orders');
  }
}
