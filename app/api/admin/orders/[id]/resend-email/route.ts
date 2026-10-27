export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { isFullAccessRestricted } from '@/lib/modules/runtime';
import { getEmailState } from '@/lib/email-delivery';
import { sendOrderEmail, sendResultResponse } from '@/lib/order-email';
import { logPaymentEvent } from '@/lib/reconciliation/shared';
import { getBaseUrl } from '@/lib/url';

/* «Reenviar email» del detalle de una venta de entradas (P0-08). Solo ADMIN. Mismo punto de envío que todo lo demás (concesión atómica, rastro
 * del intento), saltándose el backoff y el máximo de intentos, y con una línea de log de auditoría (quién y con qué resultado). */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    if (isFullAccessRestricted('entradas')) {
      return NextResponse.json({ error: 'Licencia vencida o módulo no disponible' }, { status: 402 });
    }
    const result = await sendOrderEmail('entradas', params?.id, { baseUrl: getBaseUrl(request), mode: 'manual', resend: true });
    logPaymentEvent('[order-email]', { kind: 'entradas', orderId: params?.id, reason: 'manual_resend', by: `admin:${session.user?.id ?? '-'}`, result: result.status }, 'info');
    const { httpStatus, body } = sendResultResponse(result, { detail: true });
    const state = await getEmailState('entradas', params?.id);
    return NextResponse.json({ ...body, emailDelivery: state ? { status: state.status, attempts: state.attempts, sentAt: state.sentAt, lastError: state.lastError } : null }, { status: httpStatus });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/orders/[id]/resend-email');
  }
}
