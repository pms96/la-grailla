export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const createEventSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  venue: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  imageUrl: z.string().optional().nullable(),
  artists: z.string().optional(),
  date: z.string().optional(),
  doorsOpen: z.string().optional(),
  endTime: z.string().optional(),
  minAge: z.number().optional(),
  conditions: z.string().optional(),
  maxCapacity: z.number().optional(),
  maxTicketsPerEmail: z.union([z.number(), z.string(), z.null()]).optional(),
  waitingRoomEnabled: z.boolean().optional(),
  waitingRoomConcurrentSlots: z.union([z.number(), z.string(), z.null()]).optional(),
  waitingRoomPurchaseWindowSeconds: z.union([z.number(), z.string(), z.null()]).optional(),
  waitingRoomMessage: z.string().optional().nullable(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'FINISHED', 'CANCELLED']).optional(),
  latitude: z.union([z.number(), z.string(), z.null()]).optional(),
  longitude: z.union([z.number(), z.string(), z.null()]).optional(),
  alertThresholds: z.string().optional(),
});

const ENTRY_WINDOW_MS = 5 * 60 * 1000;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const events = await prisma.event.findMany({
      include: {
        ticketTypes: { orderBy: { sortOrder: 'asc' } },
        // tickets: excluye CANCELLED/REFUNDED para que represente entradas emitidas/vendidas,
        // no el histórico completo de tickets creados alguna vez.
        _count: { select: { tickets: { where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } } }, orders: true } },
      },
      orderBy: { date: 'desc' },
    });

    const eventIds = (events ?? []).map((e) => e.id);
    const since = new Date(Date.now() - ENTRY_WINDOW_MS);
    const [recentScans, validScannerCounts] = eventIds.length
      ? await Promise.all([
          prisma.scanLog.groupBy({
            by: ['eventId', 'result'],
            where: { eventId: { in: eventIds }, createdAt: { gte: since } },
            _count: { _all: true },
          }),
          prisma.scanLog.groupBy({
            by: ['eventId', 'scannerId'],
            where: { eventId: { in: eventIds }, result: 'VALID' },
            _count: { _all: true },
          }),
        ])
      : [[], []];

    const scannerIds = Array.from(new Set(validScannerCounts.map((c) => c.scannerId).filter((id): id is string => Boolean(id))));
    const scanners = scannerIds.length
      ? await prisma.user.findMany({ where: { id: { in: scannerIds } }, select: { id: true, name: true, email: true } })
      : [];
    const scannerName = new Map(scanners.map((s) => [s.id, s.name || s.email]));

    const enriched = (events ?? []).map((ev) => {
      const scans = recentScans.filter((s) => s.eventId === ev.id);
      const validCount = scans.find((s) => s.result === 'VALID')?._count?._all ?? 0;
      const totalCount = scans.reduce((sum, s) => sum + (s._count?._all ?? 0), 0);
      const topScanners = validScannerCounts
        .filter((c) => c.eventId === ev.id && c.scannerId)
        .sort((a, b) => (b._count?._all ?? 0) - (a._count?._all ?? 0))
        .slice(0, 3)
        .map((c) => ({ name: scannerName.get(c.scannerId as string) ?? 'Desconocido', count: c._count?._all ?? 0 }));

      return {
        ...ev,
        entryRate5min: validCount,
        rejectionRate5min: totalCount > 0 ? Math.round(((totalCount - validCount) / totalCount) * 100) : null,
        topScanners,
      };
    });

    return NextResponse.json(enriched);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/events');
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = createEventSchema.parse(await request.json());
    const slug = (body?.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const event = await prisma.event.create({
      data: {
        name: body?.name ?? '',
        slug,
        description: body?.description ?? '',
        venue: body?.venue ?? '',
        city: body?.city ?? '',
        address: body?.address ?? '',
        imageUrl: body?.imageUrl ?? null,
        artists: body?.artists ?? '',
        date: new Date(body?.date ?? Date.now()),
        doorsOpen: body?.doorsOpen ?? '',
        endTime: body?.endTime ?? '',
        minAge: body?.minAge ?? 18,
        conditions: body?.conditions ?? '',
        maxCapacity: body?.maxCapacity ?? 500,
        maxTicketsPerEmail: body?.maxTicketsPerEmail === '' || body?.maxTicketsPerEmail == null ? null : Number(body.maxTicketsPerEmail),
        waitingRoomEnabled: body?.waitingRoomEnabled ?? false,
        waitingRoomConcurrentSlots: body?.waitingRoomConcurrentSlots === '' || body?.waitingRoomConcurrentSlots == null ? null : Number(body.waitingRoomConcurrentSlots),
        waitingRoomPurchaseWindowSeconds: body?.waitingRoomPurchaseWindowSeconds === '' || body?.waitingRoomPurchaseWindowSeconds == null ? null : Number(body.waitingRoomPurchaseWindowSeconds),
        waitingRoomMessage: body?.waitingRoomMessage ?? null,
        status: body?.status ?? 'DRAFT',
        latitude: body?.latitude === '' || body?.latitude == null ? null : Number(body.latitude),
        longitude: body?.longitude === '' || body?.longitude == null ? null : Number(body.longitude),
        alertThresholds: body?.alertThresholds ?? '80,95,100',
      },
    });
    return NextResponse.json(event);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/events');
  }
}
