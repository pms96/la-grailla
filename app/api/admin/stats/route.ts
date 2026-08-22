export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const WAITING_ROOM_STATUSES = ['WAITING', 'ADMITTED', 'COMPLETED', 'EXPIRED'] as const;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const eventId = url.searchParams.get('eventId') || undefined;
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    const from = fromParam ? new Date(fromParam) : undefined;
    const to = toParam ? new Date(toParam) : undefined;

    const orderWhere = {
      status: 'COMPLETED' as const,
      ...(eventId ? { eventId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    const ticketWhere = {
      status: { notIn: ['CANCELLED', 'REFUNDED'] as ('CANCELLED' | 'REFUNDED')[] },
      ...(eventId ? { eventId } : {}),
    };

    const [
      totalOrders,
      totalTickets,
      totalEvents,
      revenueAgg,
      recentOrders,
      events,
      byChannel,
      ticketTypeProgress,
      waitingRoomCounts,
      ordersForChart,
    ] = await Promise.all([
      prisma.order.count({ where: orderWhere }),
      prisma.ticket.count({ where: ticketWhere }),
      prisma.event.count(),
      prisma.order.aggregate({ where: orderWhere, _sum: { totalAmount: true, commission: true } }),
      prisma.order.findMany({
        where: orderWhere,
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { event: { select: { name: true } } },
      }),
      prisma.event.findMany({
        where: { status: { in: ['PUBLISHED', 'FINISHED'] } },
        select: { id: true, name: true, maxCapacity: true, currentCount: true, date: true, status: true, alertThresholds: true, alertsSent: true },
        orderBy: { date: 'desc' },
      }),
      prisma.order.groupBy({ by: ['channel'], where: orderWhere, _count: { _all: true }, _sum: { totalAmount: true } }),
      eventId
        ? prisma.ticketType.findMany({
            where: { eventId },
            select: { id: true, name: true, phaseName: true, soldCount: true, maxQuantity: true },
            orderBy: { phase: 'asc' },
          })
        : Promise.resolve([]),
      prisma.waitingRoomEntry.groupBy({ by: ['status'], where: eventId ? { eventId } : {}, _count: { _all: true } }),
      prisma.order.findMany({ where: orderWhere, select: { createdAt: true, totalAmount: true } }),
    ]);

    const totalRevenue = revenueAgg?._sum?.totalAmount ?? 0;
    const netRevenue = totalRevenue - (revenueAgg?._sum?.commission ?? 0);

    const dayBuckets = new Map<string, { date: string; revenue: number; count: number }>();
    (ordersForChart ?? []).forEach((o) => {
      const day = o.createdAt.toISOString().slice(0, 10);
      const bucket = dayBuckets.get(day) ?? { date: day, revenue: 0, count: 0 };
      bucket.revenue += o.totalAmount;
      bucket.count += 1;
      dayBuckets.set(day, bucket);
    });
    const salesByDay = Array.from(dayBuckets.values()).sort((a, b) => a.date.localeCompare(b.date));

    const waitingRoomFunnel = WAITING_ROOM_STATUSES.map((status) => ({
      status,
      count: waitingRoomCounts.find((w) => w.status === status)?._count?._all ?? 0,
    }));

    return NextResponse.json({
      totalOrders: totalOrders ?? 0,
      totalTickets: totalTickets ?? 0,
      totalEvents: totalEvents ?? 0,
      totalRevenue,
      netRevenue,
      recentOrders: recentOrders ?? [],
      events: events ?? [],
      byChannel: (byChannel ?? []).map((c) => ({ channel: c.channel, count: c._count?._all ?? 0, revenue: c._sum?.totalAmount ?? 0 })),
      ticketTypeProgress: ticketTypeProgress ?? [],
      waitingRoomFunnel,
      salesByDay,
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/stats');
  }
}
