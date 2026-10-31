export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { authOptions } from '@/lib/auth';
import { adminLacksModule } from '@/lib/modules/access';
import { rateLimit } from '@/lib/rate-limit';
import { handleApiError } from '@/lib/api-error';
import { ticketUnusable } from '@/lib/ticket-validity';
import { REENTRY_RESULT } from '@/lib/scan-results';

/* Reentrada (H-077). «Dentro» era un acumulado de admitidos: quien salía a fumar y volvía recibía el rojo «YA ENTRÓ» sin salida. El ADMIN puede autorizar
 * una reentrada desde el veredicto de la puerta. La entrada sigue USED, el «han entrado» no sube y el aforo real no se descuenta (no se sabe quién está
 * dentro: es un límite documentado); solo queda constancia en el registro de escaneos (`ScanLog` REENTRY) con quién la autorizó. Las respuestas llevan la
 * misma forma que las del escáner (`result` + `message` + `color`) para que la puerta las pinte igual. */

const bodySchema = z.object({ ticketId: z.string().min(1), eventId: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user || !['ADMIN', 'TAQUILLA'].includes(session.user.role ?? '')) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
    if (adminLacksModule(session.user, 'entradas')) {
      return NextResponse.json({ error: 'Sin permiso para este módulo' }, { status: 403 });
    }
    if (session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Solo un administrador puede autorizar una reentrada.' }, { status: 403 });
    }
    const limit = await rateLimit('scan-user', session.user.id, 240, 60_000);
    if (!limit.ok) {
      return NextResponse.json({ error: 'Demasiadas peticiones. Espera unos segundos.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } });
    }

    const { ticketId, eventId } = bodySchema.parse(await request.json());
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { event: true, order: true } });
    if (!ticket) {
      return NextResponse.json({ result: 'INVALID', message: 'Entrada no encontrada', color: 'red' }, { status: 404 });
    }
    if (ticket.eventId !== eventId) {
      return NextResponse.json({ result: 'WRONG_EVENT', message: 'Esta entrada es de otro evento', color: 'red' }, { status: 400 });
    }
    const unusable = ticketUnusable(ticket.order, ticket.event);
    if (unusable) {
      return NextResponse.json({ result: 'CANCELLED', message: unusable.scanMessage, color: 'red' }, { status: 410 });
    }
    // Solo quien ya entró tiene una reentrada que autorizar; una entrada sin usar se escanea con normalidad.
    if (ticket.status !== 'USED') {
      return NextResponse.json({ result: 'ERROR', message: 'Esta entrada aún no ha entrado: escanéala con normalidad.', color: 'yellow' }, { status: 409 });
    }

    await prisma.scanLog.create({ data: { ticketId: ticket.id, eventId: ticket.eventId, scannerId: session.user.id, result: REENTRY_RESULT } });
    return NextResponse.json({ result: REENTRY_RESULT, message: `REENTRADA PERMITIDA — ${ticket.holderName ?? 'Invitado'}`, holderName: ticket.holderName, color: 'green' });
  } catch (error) {
    return handleApiError(error, 'POST /api/scan/reentry');
  }
}
