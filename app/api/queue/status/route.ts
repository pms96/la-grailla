export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { sweepAndAdmit } from '@/lib/waiting-room';
import { handleApiError } from '@/lib/api-error';

const DEFAULT_CONCURRENT_SLOTS = 20;
const DEFAULT_PURCHASE_WINDOW_SECONDS = 300;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const eventId = searchParams.get('eventId');
    const token = searchParams.get('token');
    if (!eventId || !token) {
      return NextResponse.json({ error: 'Faltan parámetros' }, { status: 400 });
    }

    const limit = rateLimit('queue-status', getClientIp(request), 40, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiados intentos. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
    }

    // Igual que en /api/queue/join: si la cola se desactiva mientras alguien
    // espera, se le admite en el siguiente poll en vez de dejarlo colgado.
    if (!event.waitingRoomEnabled) {
      return NextResponse.json({ status: 'ADMITTED', token: null });
    }

    const concurrentSlots = event.waitingRoomConcurrentSlots ?? DEFAULT_CONCURRENT_SLOTS;
    const windowSeconds = event.waitingRoomPurchaseWindowSeconds ?? DEFAULT_PURCHASE_WINDOW_SECONDS;
    await sweepAndAdmit(event.id, concurrentSlots, windowSeconds);

    const entry = await prisma.waitingRoomEntry.findUnique({ where: { token } });
    if (!entry || entry.eventId !== event.id) {
      return NextResponse.json({ status: 'NOT_FOUND' });
    }

    if (entry.status === 'WAITING') {
      const position = await prisma.waitingRoomEntry.count({
        where: { eventId: event.id, status: 'WAITING', joinedAt: { lt: entry.joinedAt } },
      });
      return NextResponse.json({
        status: 'WAITING',
        position: position + 1,
        waitingRoomMessage: event.waitingRoomMessage,
      });
    }

    return NextResponse.json({ status: entry.status, expiresAt: entry.expiresAt });
  } catch (error) {
    return handleApiError(error, 'GET /api/queue/status');
  }
}
