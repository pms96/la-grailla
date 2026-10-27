export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { getBaseUrl } from '@/lib/url';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import { getTokenFromRequest, shopOrderAccessQuery, verifyShopOrderAccess } from '@/lib/access-token';
import { settleUnpaidOrder } from '@/lib/reconciliation/settle';

/* Abandono por el comprador de un pedido de TIENDA (P0-04): `cancel_url` de la sesión de pago. Misma regla que el de entradas
 * (/api/orders/[orderId]/abandon): con el token firmado del pedido, si sigue PENDING y la pasarela confirma que no hay pago, se cierra la
 * sesión y se libera el stock; pagado o no verificable, no se toca nada. El carrito sigue intacto (ya no se vacía antes de pagar), así que
 * el comprador vuelve al checkout con lo que había elegido. */
export async function GET(request: Request, props: { params: Promise<{ orderId: string }> }) {
  const params = await props.params;
  try {
    const orderId = params?.orderId;
    if (!verifyShopOrderAccess(orderId, getTokenFromRequest(request))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
    const limit = await rateLimit('shop-order-abandon', `${getClientIp(request)}:${orderId}`, 6, 60_000);
    if (!limit.ok) return NextResponse.json({ error: 'Demasiados intentos' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } });

    const order = await prisma.shopOrder.findUnique({ where: { id: orderId } });
    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });

    const baseUrl = getBaseUrl(request);
    const confirmation = `/tienda/confirmacion/${order.id}?${shopOrderAccessQuery(order.id)}`;
    const backToCheckout = '/tienda/checkout';
    const redirect = (path: string) => NextResponse.redirect(new URL(path, baseUrl), 303);

    if (order.status === 'CANCELLED' && !order.paymentId) return redirect(backToCheckout);
    if (order.status !== 'PENDING') return redirect(confirmation);

    const result = await settleUnpaidOrder({ kind: 'tienda', order, abandoned: true, baseUrl });
    return redirect(result.outcome === 'released' ? backToCheckout : confirmation);
  } catch (error) {
    return handleApiError(error, 'GET /api/shop/orders/[orderId]/abandon');
  }
}

// Next ejecutaría el GET para un HEAD (un rastreador o una precarga de enlaces): esta ruta cambia estado, así que un HEAD no debe tocar nada.
export function HEAD() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'GET' } });
}
