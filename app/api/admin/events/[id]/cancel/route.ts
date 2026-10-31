export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { cancellationProgress, previewCancellation, processCancellation, startCancellation } from '@/lib/event-cancellation';
import { actorFromSession, recordAdminAuditSafe } from '@/lib/admin-audit';

/* Cancelar un evento con compradores (P1-04). GET = vista previa (cuántos pedidos, cuánto dinero) y estado del trabajo si ya está en marcha.
 * POST `start` = cancela (cierra venta y escáner al instante) y procesa un primer lote; POST `continue` = sigue con el siguiente lote. El resto lo
 * continúa solo el cron de reconciliación (ver lib/event-cancellation.ts). Solo ADMIN; el control por módulo lo hace el middleware (/api/admin/events). */

/** Tiempo para EMPEZAR llamadas en un lote de la propia petición; a eso se suma el tope de una llamada en vuelo (25 s): queda por debajo de `maxDuration` (60 s). */
const BATCH_MS = 25_000;

const bodySchema = z.object({
  action: z.enum(['start', 'continue']),
  refund: z.boolean().default(true),
  notify: z.boolean().default(true),
});

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const event = await prisma.event.findUnique({ where: { id: params.id }, select: { id: true, name: true, status: true, date: true } });
    if (!event) return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
    const [preview, progress] = await Promise.all([previewCancellation(event.id), cancellationProgress(event.id)]);
    return NextResponse.json({ event, preview, progress });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/events/[id]/cancel');
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = bodySchema.parse(await request.json());
    const event = await prisma.event.findUnique({ where: { id: params.id }, select: { id: true, status: true } });
    if (!event) return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });

    if (body.action === 'start') {
      const job = await startCancellation(event.id, { refund: body.refund, notify: body.notify, startedBy: session.user?.id ?? null });
      await recordAdminAuditSafe(actorFromSession(session), request, {
        action: 'event.cancel',
        targetType: 'Event',
        targetId: event.id,
        meta: { refund: job.refund, notify: job.notify },
      });
      const progress = await processCancellation(event.id, { deadline: Date.now() + BATCH_MS });
      return NextResponse.json({ progress, options: { refund: job.refund, notify: job.notify } });
    }

    const existing = await cancellationProgress(event.id);
    if (!existing) return NextResponse.json({ error: 'No hay una cancelación en curso para este evento' }, { status: 404 });
    const progress = await processCancellation(event.id, { deadline: Date.now() + BATCH_MS });
    return NextResponse.json({ progress });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/events/[id]/cancel');
  }
}
