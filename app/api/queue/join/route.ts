export const dynamic = 'force-dynamic';

import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { sweepAndAdmit } from '@/lib/waiting-room';
import { handleApiError } from '@/lib/api-error';

// Valores por defecto si el admin activa la sala de espera sin rellenar los
// campos numéricos (evita que se quede sin admitir a nadie por slots=0).
const DEFAULT_CONCURRENT_SLOTS = 20;
const DEFAULT_PURCHASE_WINDOW_SECONDS = 300;

const joinSchema = z.object({
  eventId: z.string().min(1),
  token: z.string().optional().nullable(),
});

export async function POST(request: Request) {
  try {
    const limit = rateLimit('queue-join', getClientIp(request), 20, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiados intentos. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const body = joinSchema.parse(await request.json());
    const event = await prisma.event.findUnique({ where: { id: body.eventId } });
    if (!event) {
      return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
    }

    // La cola puede desactivarse mientras alguien ya está esperando: hay que
    // dejarle pasar de inmediato en vez de que se quede colgado a la espera
    // de un barrido que ya no le va a llegar el turno.
    if (!event.waitingRoomEnabled) {
      return NextResponse.json({ status: 'ADMITTED', token: null });
    }

    const concurrentSlots = event.waitingRoomConcurrentSlots ?? DEFAULT_CONCURRENT_SLOTS;
    const windowSeconds = event.waitingRoomPurchaseWindowSeconds ?? DEFAULT_PURCHASE_WINDOW_SECONDS;

    let entry = body.token
      ? await prisma.waitingRoomEntry.findUnique({ where: { token: body.token } })
      : null;
    if (!entry || entry.eventId !== event.id) {
      entry = await prisma.waitingRoomEntry.create({
        data: { eventId: event.id, token: crypto.randomUUID() },
      });
    }

    await sweepAndAdmit(event.id, concurrentSlots, windowSeconds);

    const fresh = await prisma.waitingRoomEntry.findUnique({ where: { id: entry.id } });
    if (!fresh) {
      return NextResponse.json({ error: 'No se ha podido unir a la cola' }, { status: 500 });
    }

    if (fresh.status === 'WAITING') {
      const position = await prisma.waitingRoomEntry.count({
        where: { eventId: event.id, status: 'WAITING', joinedAt: { lt: fresh.joinedAt } },
      });
      return NextResponse.json({
        status: 'WAITING',
        token: fresh.token,
        position: position + 1,
        waitingRoomMessage: event.waitingRoomMessage,
      });
    }

    return NextResponse.json({
      status: fresh.status,
      token: fresh.token,
      expiresAt: fresh.expiresAt,
      waitingRoomMessage: event.waitingRoomMessage,
    });
  } catch (error) {
    return handleApiError(error, 'POST /api/queue/join');
  }
}
