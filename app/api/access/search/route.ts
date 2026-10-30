export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { adminLacksModule } from '@/lib/modules/access';
import { authOptions } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { handleApiError } from '@/lib/api-error';
import { ticketUnusable } from '@/lib/ticket-validity';
import { maskEmail, orderRef } from '@/lib/door-search';

/* Búsqueda de asistentes en la PUERTA (P1-06 / EN-12): «no encuentro el email» es el motivo nº 1 de soporte en la entrada. El personal escribe un
 * nombre, un email o la referencia del pedido y admite a mano desde el resultado (`POST /api/scan` con `ticketId`). Vive bajo `/api/access`, así que
 * sigue operativa con la licencia vencida: en la puerta hay que poder validar entradas ya vendidas (lib/modules/registry.ts).
 *
 * Solo devuelve lo que hace falta para reconocer a la persona (nombre, email ENMASCARADO, referencia) y para decidir (si puede entrar y, si no,
 * por qué). Nunca el email completo ni el QR: quien busca es personal de puerta, no el titular. */

const MIN_QUERY = 3;
const MAX_WORDS = 4;
const LIMIT = 15;
const SEARCH_LIMIT_PER_MIN = 90;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN' && session?.user?.role !== 'TAQUILLA') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  if (adminLacksModule(session.user, 'entradas')) {
    return NextResponse.json({ error: 'Sin permiso para este módulo' }, { status: 403 });
  }
  try {
    const limit = await rateLimit('scan-search', session.user.id, SEARCH_LIMIT_PER_MIN, 60_000);
    if (!limit.ok) {
      return NextResponse.json({ error: 'Demasiadas búsquedas. Espera unos segundos.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } });
    }

    const params = new URL(request.url).searchParams;
    const eventId = params.get('eventId') ?? '';
    const q = (params.get('q') ?? '').trim();
    if (!eventId) return NextResponse.json({ error: 'eventId requerido' }, { status: 400 });
    if (q.length < MIN_QUERY) return NextResponse.json({ error: `Escribe al menos ${MIN_QUERY} caracteres` }, { status: 400 });

    // Cada palabra debe aparecer en algún campo («juan perez» encuentra a Juan Pérez aunque nombre y apellido estén en campos distintos).
    const words = q.split(/\s+/).filter((w) => w.length > 0).slice(0, MAX_WORDS);
    const wordFilter = (w: string): Prisma.TicketWhereInput => ({
      OR: [
        { holderName: { contains: w, mode: 'insensitive' } },
        { order: { buyerName: { contains: w, mode: 'insensitive' } } },
        { order: { buyerLastName: { contains: w, mode: 'insensitive' } } },
        // El email solo casa ENTERO: con `contains` se podía reconstruir carácter a carácter el email que la respuesta enmascara (revisión de P1-06).
        ...(w.includes('@') ? [{ order: { buyerEmail: { equals: w, mode: 'insensitive' as const } } }] : []),
        { order: { id: { endsWith: w.toLowerCase() } } },
        { qrCode: { equals: w, mode: 'insensitive' } },
      ],
    });

    const tickets = await prisma.ticket.findMany({
      where: { eventId, AND: words.map(wordFilter) },
      orderBy: { createdAt: 'desc' },
      take: LIMIT + 1,
      select: {
        id: true,
        holderName: true,
        status: true,
        entryTime: true,
        ticketType: { select: { name: true } },
        order: { select: { id: true, status: true, buyerName: true, buyerLastName: true, buyerEmail: true } },
        event: { select: { status: true } },
      },
    });

    const results = tickets.slice(0, LIMIT).map((t) => {
      const unusable = ticketUnusable(t.order, t.event);
      // Solo se puede admitir una entrada VALID de un pedido cobrado y un evento no cancelado. El resto se enseña igualmente, con el motivo,
      // para que el personal entienda por qué no entra («ya entró a las 21:14», «pedido reembolsado») en vez de no encontrarla.
      const admittable = t.status === 'VALID' && !unusable;
      return {
        ticketId: t.id,
        holderName: t.holderName,
        ticketType: t.ticketType?.name ?? null,
        status: t.status,
        entryTime: t.entryTime,
        buyerName: `${t.order.buyerName} ${t.order.buyerLastName}`.trim(),
        buyerEmail: maskEmail(t.order.buyerEmail),
        orderRef: orderRef(t.order.id),
        admittable,
        blockedMessage: admittable ? null : unusable?.scanMessage ?? null,
      };
    });

    return NextResponse.json({ results, truncated: tickets.length > LIMIT });
  } catch (error) {
    return handleApiError(error, 'GET /api/access/search');
  }
}
