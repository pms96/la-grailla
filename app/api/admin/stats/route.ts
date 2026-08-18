export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const [totalOrders, totalTickets, totalEvents, totalRevenue, recentOrders, events] = await Promise.all([
      prisma.order.count({ where: { status: 'COMPLETED' } }),
      prisma.ticket.count(),
      prisma.event.count(),
      prisma.order.aggregate({ where: { status: 'COMPLETED' }, _sum: { totalAmount: true } }),
      prisma.order.findMany({
        where: { status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { event: { select: { name: true } } },
      }),
      prisma.event.findMany({
        where: { status: { in: ['PUBLISHED', 'FINISHED'] } },
        select: { id: true, name: true, maxCapacity: true, currentCount: true, date: true, status: true, alertThresholds: true, alertsSent: true },
        orderBy: { date: 'desc' },
      }),
    ]);

    return NextResponse.json({
      totalOrders: totalOrders ?? 0,
      totalTickets: totalTickets ?? 0,
      totalEvents: totalEvents ?? 0,
      totalRevenue: totalRevenue?._sum?.totalAmount ?? 0,
      recentOrders: recentOrders ?? [],
      events: events ?? [],
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/stats');
  }
}
