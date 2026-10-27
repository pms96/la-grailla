export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { buyerResendLimit, sendOrderEmail, sendResultResponse } from '@/lib/order-email';
import { logPaymentEvent } from '@/lib/reconciliation/shared';
import { getBaseUrl } from '@/lib/url';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { handleApiError } from '@/lib/api-error';
import { allowOrderAccess } from '@/lib/access-token';

const sendTicketsSchema = z.object({
  force: z.boolean().optional(),
  softResend: z.boolean().optional(),
  t: z.string().optional(),
});

function isStaff(role: string | undefined): boolean {
  return role === 'ADMIN' || role === 'TAQUILLA';
}

/* Envío del email de entradas a petición (P0-08), SIEMPRE por el único punto de envío (concesión atómica: dos clics o un clic y el webhook no
 * duplican).
 *  - Comprador (token firmado del pedido) con `softResend`: «Reenviar a mi email», 3 por hora y pedido. Salta el backoff, nunca la concesión.
 *  - Comprador sin `softResend`: un empujón que respeta el backoff y no reenvía lo ya enviado (clientes antiguos que lo llamaban al abrir la pantalla).
 *  - Personal (`force`, sesión ADMIN/TAQUILLA): reenvío sin límite por pedido. El admin usa /api/admin/orders/[id]/resend-email, que además es solo ADMIN. */
export async function POST(request: Request, props: { params: Promise<{ orderId: string }> }) {
  const params = await props.params;
  try {
    const limit = await rateLimit('send-tickets', getClientIp(request), 5, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiados envios. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    let force = false;
    let softResend = false;
    let token: string | undefined;
    try {
      const body = sendTicketsSchema.parse(await request.json());
      force = Boolean(body?.force);
      softResend = Boolean(body?.softResend);
      token = body?.t;
    } catch {
      // body vacío
    }

    const session = await getServerSession(authOptions);
    const staff = isStaff(session?.user?.role);

    if (force) {
      if (!staff) {
        return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
      }
    } else if (!(await allowOrderAccess(params?.orderId, token))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const manual = force || softResend;
    if (manual && !staff) {
      const perOrder = await buyerResendLimit('entradas', params?.orderId);
      if (!perOrder.ok) {
        return NextResponse.json(
          { success: false, status: 'rate_limited', error: 'Has pedido demasiados reenvíos de este pedido. Inténtalo de nuevo más tarde.' },
          { status: 429, headers: { 'Retry-After': String(perOrder.retryAfter) } }
        );
      }
    }

    const result = await sendOrderEmail('entradas', params?.orderId, { baseUrl: getBaseUrl(request), mode: manual ? 'manual' : 'auto', resend: manual });
    if (manual) {
      logPaymentEvent('[order-email]', { kind: 'entradas', orderId: params?.orderId, reason: 'manual_resend', by: staff ? `staff:${session?.user?.id ?? '-'}` : 'buyer', result: result.status }, 'info');
    }
    const { httpStatus, body } = sendResultResponse(result, { detail: staff });
    return NextResponse.json(body, { status: httpStatus });
  } catch (error) {
    return handleApiError(error, 'POST /api/orders/[orderId]/send-tickets');
  }
}
