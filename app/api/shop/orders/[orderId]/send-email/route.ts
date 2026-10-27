export const dynamic = 'force-dynamic';
// El envío de un email con el SMTP del cliente puede tardar hasta sus tiempos máximos (10/10/20 s): con margen.
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { handleApiError } from '@/lib/api-error';
import { allowShopOrderAccess, getTokenFromRequest } from '@/lib/access-token';
import { buyerResendLimit, sendOrderEmail, sendResultResponse } from '@/lib/order-email';
import { logPaymentEvent } from '@/lib/reconciliation/shared';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import { getBaseUrl } from '@/lib/url';

/* «Reenviar a mi email» de la confirmación de un pedido de TIENDA (P0-08). Protegido por el token firmado del pedido (el mismo que ya usa la
 * confirmación) o por una sesión de personal; límite de 5 por minuto e IP y de 3 por hora y pedido; siempre por el único punto de envío
 * (concesión atómica: un doble clic no manda dos emails). El comprador nunca ve el texto del error. */
export async function POST(request: Request, props: { params: Promise<{ orderId: string }> }) {
  const params = await props.params;
  try {
    const orderId = params?.orderId;
    const ip = await rateLimit('shop-send-email', getClientIp(request), 5, 60_000);
    if (!ip.ok) return NextResponse.json({ error: 'Demasiados envíos. Espera un momento.' }, { status: 429, headers: { 'Retry-After': String(ip.retryAfter) } });

    if (!(await allowShopOrderAccess(orderId, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const perOrder = await buyerResendLimit('tienda', orderId);
    if (!perOrder.ok) {
      return NextResponse.json(
        { success: false, status: 'rate_limited', error: 'Has pedido demasiados reenvíos de este pedido. Inténtalo de nuevo más tarde.' },
        { status: 429, headers: { 'Retry-After': String(perOrder.retryAfter) } }
      );
    }

    const result = await sendOrderEmail('tienda', orderId, { baseUrl: getBaseUrl(request), mode: 'manual', resend: true });
    logPaymentEvent('[order-email]', { kind: 'tienda', orderId, reason: 'manual_resend', by: 'buyer', result: result.status }, 'info');
    const { httpStatus, body } = sendResultResponse(result);
    return NextResponse.json(body, { status: httpStatus });
  } catch (error) {
    return handleApiError(error, 'POST /api/shop/orders/[orderId]/send-email');
  }
}
