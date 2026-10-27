export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { getBaseUrl } from '@/lib/url';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import { getTokenFromRequest, orderAccessQuery, verifyOrderAccess } from '@/lib/access-token';
import { settleUnpaidOrder } from '@/lib/reconciliation/settle';

/* Abandono por el comprador (P0-04): es el `cancel_url` de la sesión de pago. Al pulsar «volver» en la pasarela el comprador llega aquí con
 * el token firmado de su pedido (el mismo de la confirmación). Si el pedido sigue sin pagar y la pasarela lo confirma, se cierra la sesión
 * y se libera el aforo al instante en vez de retenerlo hasta que caduque. Si ya estaba pagado no se toca nada; si la pasarela no se puede
 * consultar, tampoco (nunca se libera con UNKNOWN). Siempre acaba en una redirección.
 *
 * Es un GET que cambia estado (la pasarela redirige al navegador con un GET): es seguro porque solo actúa con el token firmado del pedido,
 * solo sobre un pedido PENDING, solo con la pasarela confirmando que no hay pago, y es idempotente. */
export async function GET(request: Request, props: { params: Promise<{ orderId: string }> }) {
  const params = await props.params;
  try {
    const orderId = params?.orderId;
    if (!verifyOrderAccess(orderId, getTokenFromRequest(request))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
    // Cada llamada consulta la pasarela: se limita por pedido e IP para que un enlace filtrado no sirva para martillearla.
    const limit = await rateLimit('order-abandon', `${getClientIp(request)}:${orderId}`, 6, 60_000);
    if (!limit.ok) return NextResponse.json({ error: 'Demasiados intentos' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } });

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { event: { select: { slug: true } } } });
    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });

    const baseUrl = getBaseUrl(request);
    const confirmation = `/confirmacion/${order.id}?${orderAccessQuery(order.id)}`;
    const backToBuy = `/eventos/${order.event.slug}/comprar`;
    const redirect = (path: string) => NextResponse.redirect(new URL(path, baseUrl), 303);

    if (order.status === 'CANCELLED' && !order.paymentId) return redirect(backToBuy);
    if (order.status !== 'PENDING') return redirect(confirmation); // pagado, o liberado con pago asociado: la confirmación lo comprueba y lo explica

    const result = await settleUnpaidOrder({ kind: 'entradas', order, abandoned: true, baseUrl });
    return redirect(result.outcome === 'released' ? backToBuy : confirmation);
  } catch (error) {
    return handleApiError(error, 'GET /api/orders/[orderId]/abandon');
  }
}

// Next ejecutaría el GET para un HEAD (un rastreador o una precarga de enlaces): esta ruta cambia estado, así que un HEAD no debe tocar nada.
export function HEAD() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'GET' } });
}
