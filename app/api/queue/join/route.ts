export const dynamic = 'force-dynamic';

import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { liveWaitingWhere, pollAfterMsFor, sweepAndAdmit, touchWaitingEntry } from '@/lib/waiting-room';
import { handleApiError } from '@/lib/api-error';
import { waitingRoomSettings } from '@/lib/waiting-room-settings';
import { captchaRejection, verifyCaptcha } from '@/lib/captcha';

// El rate limit de arriba (20/60s) frena ráfagas, pero no a un script que
// reparte sus peticiones despacio en el tiempo: sin este límite, la misma
// máquina podría acumular cientos de "personas" en cola o con turno
// ADMITTED, adelantando a compradores reales. Se cuentan solo entradas
// vivas (WAITING/ADMITTED) — una vez COMPLETED/EXPIRED, ya no cuentan contra
// el límite y esa IP puede volver a entrar.
// H-072: eran 3 y una oficina, un wifi de local o una IP móvil compartida (CGNAT) dejaba a la 4.ª persona fuera. Es un freno contra scripts, no una
// defensa completa (rotando IP se evade; la defensa real es el captcha): 10 por defecto, ajustable por despliegue con WAITING_ROOM_MAX_LIVE_PER_IP.
const MAX_LIVE_ENTRIES_PER_IP = (() => {
  const n = Number.parseInt(process.env.WAITING_ROOM_MAX_LIVE_PER_IP ?? '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 10;
})();

const joinSchema = z.object({
  eventId: z.string().min(1),
  token: z.string().optional().nullable(),
  // Token del captcha (Turnstile) si el cliente lo tiene activado: solo hace falta para ENTRAR en la cola, no para seguir en ella.
  captchaToken: z.string().max(2100).optional().nullable(),
});

export async function POST(request: Request) {
  try {
    // Una entrada por persona: 60 por minuto y IP aguanta una oficina o una IP móvil compartida sin dejar pasar un script (el tope de turnos vivos lo frena igual).
    const limit = await rateLimit('queue-join', getClientIp(request), 60, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiados intentos. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const body = joinSchema.parse(await request.json());
    const ip = getClientIp(request);
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

    const { concurrentSlots, windowSeconds } = waitingRoomSettings(event);

    let entry = body.token
      ? await prisma.waitingRoomEntry.findUnique({ where: { token: body.token } })
      : null;
    // Un token EXPIRED nunca vuelve a WAITING por sí solo — sin este chequeo,
    // alguien que vuelve a /comprar días después (con el token todavía en su
    // localStorage) se encuentra la pantalla de "tu turno ha terminado" de
    // entrada en vez de entrar en la cola de nuevo, porque se reutilizaba esa
    // misma fila y se le devolvía EXPIRED en bucle. COMPLETED no entra aquí a
    // propósito: el cliente ya lo trata aparte para poder avisar con un toast
    // de que su compra anterior sí se guardó.
    if (!entry || entry.eventId !== event.id || entry.status === 'EXPIRED') {
      const liveEntriesFromIp = await prisma.waitingRoomEntry.count({
        where: { eventId: event.id, ip, status: { in: ['WAITING', 'ADMITTED'] } },
      });
      if (liveEntriesFromIp >= MAX_LIVE_ENTRIES_PER_IP) {
        return NextResponse.json(
          { error: 'Ya hay demasiados turnos abiertos para este evento desde esta conexión. Espera a que alguno termine e inténtalo de nuevo.', code: 'queue_ip_limit' },
          { status: 429 }
        );
      }
      // Entrar en la cola (turno nuevo) exige el captcha; quien ya tiene turno vivo y solo lo consulta no lo ve nunca. El navegador intenta sin token
      // y, si llega `captcha_required`, pinta el widget y reintenta con él. Va DESPUÉS del tope por IP: quien ya no puede entrar no gasta un token.
      const captcha = await verifyCaptcha(request, body.captchaToken, 'queue');
      if (!captcha.ok) return captchaRejection(captcha);
      entry = await prisma.waitingRoomEntry.create({
        data: { eventId: event.id, token: crypto.randomUUID(), ip, lastSeenAt: new Date() },
      });
    } else {
      // Vuelve con su turno (recarga la página): cuenta como presente, para que el barrido no lo salte (H-071).
      await touchWaitingEntry({ id: entry.id });
    }

    await sweepAndAdmit(event.id, concurrentSlots, windowSeconds);

    const fresh = await prisma.waitingRoomEntry.findUnique({ where: { id: entry.id } });
    if (!fresh) {
      return NextResponse.json({ error: 'No se ha podido unir a la cola' }, { status: 500 });
    }

    if (fresh.status === 'WAITING') {
      const position = await prisma.waitingRoomEntry.count({
        where: { eventId: event.id, ...liveWaitingWhere(), joinedAt: { lt: fresh.joinedAt } },
      });
      return NextResponse.json({
        status: 'WAITING',
        token: fresh.token,
        position: position + 1,
        waitingRoomMessage: event.waitingRoomMessage,
        pollAfterMs: pollAfterMsFor(position + 1),
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
