export const dynamic = 'force-dynamic';
// Al confirmar el pago aquí, el email se envía tras responder (`after`): ese trabajo cuenta para el límite de la función.
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { completeOrder } from '@/lib/reconciliation/entradas';
import { getBaseUrl } from '@/lib/url';
import { handleApiError } from '@/lib/api-error';
import { allowOrderAccess, getTokenFromRequest } from '@/lib/access-token';
import { withoutSeasonLink } from '@/lib/modules/season-link';
import { LATE_PAYMENT_WINDOW_MS, checkCancelledOrderPayment } from '@/lib/reconciliation/payment-check';
import type { PaymentCheck } from '@/lib/confirmation-state';
import { getEmailState } from '@/lib/email-delivery';
import { buyerEmailView } from '@/lib/order-email';
import { buildFiscalView, isOnlineSale } from '@/lib/fiscal';

const includeTicketsAndEvent = { event: true, tickets: { include: { ticketType: true } } } as const;

export async function GET(request: Request, props: { params: Promise<{ orderId: string }> }) {
  const params = await props.params;
  try {
    const orderId = params?.orderId;
    if (!(await allowOrderAccess(orderId, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    let order = await prisma.order.findUnique({
      where: { id: orderId },
      include: includeTicketsAndEvent,
    });

    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }

    // El pedido queda PENDING hasta que el comprador paga en la pasarela. Al
    // consultarlo (p. ej. al volver del checkout) comprobamos el estado real
    // del pago antes de dar la entrada por válida — nadie debe poder ver
    // "confirmado" solo por visitar esta URL.
    if (order.status === 'PENDING' && order.paymentProvider && order.paymentProvider !== 'mock' && order.paymentId) {
      try {
        const provider = await getPaymentProviderByName(order.paymentProvider);
        const result = await provider.verifyPayment(order.paymentId);
        if (result.success) {
          await completeOrder(order.id, getBaseUrl(request), result);
          order = await prisma.order.findUnique({ where: { id: order.id }, include: includeTicketsAndEvent });
        }
      } catch (error) {
        console.error('Payment verification error:', error instanceof Error ? error.message : error);
      }
    }

    // Pedido CANCELLED (liberado por caducidad o anulado) con pago asociado en los últimos 7 días: el comprador pudo pagar DESPUÉS de liberarse
    // (SumUp no tiene webhook, y el de Stripe puede retrasarse). Se comprueba (con caché y límite) y se DEVUELVE el resultado explícito para que la
    // pantalla diga lo correcto: «no se ha cobrado nada» solo si la pasarela lo confirma. Si resulta pagado, completeOrder lo reanima o lo reembolsa.
    let paymentCheck: PaymentCheck = 'none';
    if (order && order.status === 'CANCELLED' && order.paymentId && Date.now() - order.createdAt.getTime() < LATE_PAYMENT_WINDOW_MS) {
      const orderId = order.id;
      paymentCheck = await checkCancelledOrderPayment({
        kind: 'entradas',
        request,
        order,
        complete: (paid) => completeOrder(orderId, getBaseUrl(request), paid),
      });
      if (paymentCheck === 'paid' || paymentCheck === 'refunded') {
        order = await prisma.order.findUnique({ where: { id: orderId }, include: includeTicketsAndEvent });
      }
    }

    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }

    // Estado REAL del email para la pantalla (la confirmación ya no afirma «te hemos enviado un email» sin comprobarlo). Sin el texto del error: es interno.
    const emailDelivery = order.status === 'COMPLETED' ? buyerEmailView(await getEmailState('entradas', order.id)) : null;
    const { emailLastError: _internal, ...publicOrder } = withoutSeasonLink(order);
    // P0-11: datos del vendedor e IVA del justificante (solo con el pedido pagado).
    const fiscal = order.status === 'COMPLETED' && isOnlineSale(order) ? await buildFiscalView(order.totalAmount, order.vatRate) : null;
    return NextResponse.json({ ...publicOrder, paymentCheck, emailDelivery, fiscal });
  } catch (error) {
    return handleApiError(error, 'GET /api/orders/[orderId]');
  }
}
