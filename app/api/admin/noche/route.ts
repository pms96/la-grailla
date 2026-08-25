export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const ENTRY_WINDOW_MS = 5 * 60 * 1000;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const eventId = new URL(request.url).searchParams.get('eventId');
    if (!eventId) {
      return NextResponse.json({ error: 'eventId requerido' }, { status: 400 });
    }

    const since = new Date(Date.now() - ENTRY_WINDOW_MS);

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        slug: true,
        date: true,
        doorsOpen: true,
        venue: true,
        city: true,
        status: true,
        maxCapacity: true,
        currentCount: true,
      },
    });
    if (!event) {
      return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
    }

    const [sold, ticketTypes, validScans, totalScans, recentOrders, recentScans, validScannerCounts] =
      await Promise.all([
        prisma.ticket.count({
          where: { eventId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        }),
        prisma.ticketType.findMany({
          where: { eventId },
          select: { id: true, name: true, phaseName: true, soldCount: true, maxQuantity: true },
          orderBy: { sortOrder: 'asc' },
        }),
        prisma.scanLog.count({
          where: { eventId, result: 'VALID', createdAt: { gte: since } },
        }),
        prisma.scanLog.count({
          where: { eventId, createdAt: { gte: since } },
        }),
        prisma.order.findMany({
          where: { eventId, status: 'COMPLETED' },
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: {
            id: true,
            buyerName: true,
            buyerLastName: true,
            buyerEmail: true,
            totalAmount: true,
            channel: true,
            createdAt: true,
            _count: { select: { tickets: true } },
          },
        }),
        prisma.scanLog.findMany({
          where: { eventId },
          orderBy: { createdAt: 'desc' },
          take: 12,
          select: {
            id: true,
            result: true,
            createdAt: true,
            ticket: { select: { holderName: true, ticketType: { select: { name: true } } } },
            scanner: { select: { name: true } },
          },
        }),
        prisma.scanLog.groupBy({
          by: ['scannerId'],
          where: { eventId, result: 'VALID', createdAt: { gte: since } },
          _count: { _all: true },
        }),
      ]);

    const scannerIds = validScannerCounts
      .map((c) => c.scannerId)
      .filter((id): id is string => Boolean(id));
    const scanners = scannerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: scannerIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const scannerName = new Map(scanners.map((s) => [s.id, s.name || s.email || 'Staff']));

    const topScanners = validScannerCounts
      .map((c) => ({
        name: c.scannerId ? scannerName.get(c.scannerId) ?? 'Staff' : 'Staff',
        count: c._count._all,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    const current = event.currentCount ?? 0;
    const max = event.maxCapacity ?? 0;

    return NextResponse.json({
      event,
      capacity: {
        current,
        max,
        sold: sold ?? 0,
        pending: Math.max(0, (sold ?? 0) - current),
        percent: max > 0 ? Math.round((current / max) * 100) : 0,
        entryRate5min: validScans ?? 0,
        rejectionRate5min:
          totalScans > 0 ? Math.round(((totalScans - validScans) / totalScans) * 100) : null,
      },
      ticketTypes: ticketTypes ?? [],
      topScanners,
      recentOrders: recentOrders ?? [],
      recentScans: (recentScans ?? []).map((s) => ({
        id: s.id,
        result: s.result,
        createdAt: s.createdAt,
        holderName: s.ticket?.holderName ?? '—',
        ticketType: s.ticket?.ticketType?.name ?? null,
        scannerName: s.scanner?.name ?? null,
      })),
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/noche');
  }
}
