export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { liveWaitingWhere, pollAfterMsFor, sweepAndAdmit, touchWaitingEntry } from '@/lib/waiting-room';
import { handleApiError } from '@/lib/api-error';

const DEFAULT_CONCURRENT_SLOTS = 20;
const DEFAULT_PURCHASE_WINDOW_SECONDS = 300;
// Los sondeos de estado no barren más de una vez por segundo y evento en cada instancia (P1-12): ver `sweepAndAdmit`.
const STATUS_SWEEP_MIN_INTERVAL_MS = 1000;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const eventId = searchParams.get('eventId');
    const token = searchParams.get('token');
    if (!eventId || !token) {
      return NextResponse.json({ error: 'Faltan parámetros' }, { status: 400 });
    }

    // Por IP, con holgura para una oficina o una IP móvil compartida (H-072): 40/min dejaba sin cola a la 4.ª persona (cada una sondea ~12-37 veces/min).
    // 600/min (10/s) sigue frenando a un script que martillee. No se añade un segundo límite por token: duplicaría la escritura de cada sondeo.
    const limit = await rateLimit('queue-status', getClientIp(request), 600, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiados intentos. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    // Solo lo que se usa: este sondeo se repite miles de veces por segundo y la ficha completa del evento lleva textos largos.
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, waitingRoomEnabled: true, waitingRoomConcurrentSlots: true, waitingRoomPurchaseWindowSeconds: true, waitingRoomMessage: true },
    });
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
    // Latido (H-071): ANTES del barrido, para que quien sondea cuente como presente en esta misma pasada.
    await touchWaitingEntry({ token, eventId: event.id });
    await sweepAndAdmit(event.id, concurrentSlots, windowSeconds, { minIntervalMs: STATUS_SWEEP_MIN_INTERVAL_MS });

    const entry = await prisma.waitingRoomEntry.findUnique({ where: { token } });
    if (!entry || entry.eventId !== event.id) {
      return NextResponse.json({ status: 'NOT_FOUND' });
    }

    if (entry.status === 'WAITING') {
      const position = await prisma.waitingRoomEntry.count({
        where: { eventId: event.id, ...liveWaitingWhere(), joinedAt: { lt: entry.joinedAt } },
      });
      return NextResponse.json({
        status: 'WAITING',
        token: entry.token,
        position: position + 1,
        waitingRoomMessage: event.waitingRoomMessage,
        pollAfterMs: pollAfterMsFor(position + 1),
      });
    }

    return NextResponse.json({ status: entry.status, token: entry.token, expiresAt: entry.expiresAt });
  } catch (error) {
    return handleApiError(error, 'GET /api/queue/status');
  }
}
