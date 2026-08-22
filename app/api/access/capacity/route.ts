export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const ENTRY_WINDOW_MS = 5 * 60 * 1000;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN' && session?.user?.role !== 'TAQUILLA') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const eventId = new URL(request.url).searchParams.get('eventId');
    if (!eventId) {
      return NextResponse.json({ error: 'eventId requerido' }, { status: 400 });
    }

    const since = new Date(Date.now() - ENTRY_WINDOW_MS);

    const [event, sold, ticketTypes, validScans, totalScans] = await Promise.all([
      prisma.event.findUnique({ where: { id: eventId }, select: { currentCount: true, maxCapacity: true } }),
      prisma.ticket.count({ where: { eventId, status: { notIn: ['CANCELLED', 'REFUNDED'] } } }),
      prisma.ticketType.findMany({
        where: { eventId },
        select: { id: true, name: true, phaseName: true, soldCount: true, maxQuantity: true },
        orderBy: { sortOrder: 'asc' },
      }),
      prisma.scanLog.count({ where: { eventId, result: 'VALID', createdAt: { gte: since } } }),
      prisma.scanLog.count({ where: { eventId, createdAt: { gte: since } } }),
    ]);

    if (!event) {
      return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
    }

    return NextResponse.json({
      current: event.currentCount ?? 0,
      max: event.maxCapacity ?? 0,
      sold: sold ?? 0,
      ticketTypes: ticketTypes ?? [],
      entryRate5min: validScans ?? 0,
      rejectionRate5min: totalScans > 0 ? Math.round(((totalScans - validScans) / totalScans) * 100) : null,
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/access/capacity');
  }
}
