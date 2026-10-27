export const dynamic = 'force-dynamic';
// Al confirmar el pago aquí, el email se envía tras responder (`after`): ese trabajo cuenta para el límite de la función.
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { completeShopOrder } from '@/lib/reconciliation/tienda';
import { handleApiError } from '@/lib/api-error';
import { allowShopOrderAccess, getTokenFromRequest } from '@/lib/access-token';
import { withoutSeasonLink } from '@/lib/modules/season-link';
import { LATE_PAYMENT_WINDOW_MS, checkCancelledOrderPayment } from '@/lib/reconciliation/payment-check';
import type { PaymentCheck } from '@/lib/confirmation-state';
import { SHOP_PAID_STATUSES, getEmailState } from '@/lib/email-delivery';
import { buyerEmailView } from '@/lib/order-email';

export async function GET(request: Request, props: { params: Promise<{ orderId: string }> }) {
  const params = await props.params;
  try {
    const orderId = params?.orderId;
    if (!(await allowShopOrderAccess(orderId, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    let order = await prisma.shopOrder.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: true } } },
    });

    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }

    if (
      order.status === 'PENDING' &&
      order.paymentProvider &&
      order.paymentProvider !== 'mock' &&
      order.paymentId
    ) {
      try {
        const provider = await getPaymentProviderByName(order.paymentProvider, 'tienda');
        const result = await provider.verifyPayment(order.paymentId);
        if (result.success) {
          await completeShopOrder(order.id, result);
          order = await prisma.shopOrder.findUnique({
            where: { id: order.id },
            include: { items: { include: { product: true } } },
          });
        }
      } catch (error) {
        console.error('Shop payment verification error:', error instanceof Error ? error.message : error);
      }
    }

    // Pedido CANCELLED con pago asociado en los últimos 7 días: pudo pagarse DESPUÉS de liberarse. Mismo criterio que /api/orders/[orderId]
    // (comprobación con caché y límite, resultado explícito en `paymentCheck`).
    let paymentCheck: PaymentCheck = 'none';
    if (order && order.status === 'CANCELLED' && order.paymentId && Date.now() - order.createdAt.getTime() < LATE_PAYMENT_WINDOW_MS) {
      const shopOrderId = order.id;
      paymentCheck = await checkCancelledOrderPayment({
        kind: 'tienda',
        request,
        order,
        complete: (paid) => completeShopOrder(shopOrderId, paid),
      });
      if (paymentCheck === 'paid' || paymentCheck === 'refunded') {
        order = await prisma.shopOrder.findUnique({ where: { id: shopOrderId }, include: { items: { include: { product: true } } } });
      }
    }

    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }

    // Estado REAL del email para la pantalla (ver /api/orders/[orderId]).
    const emailDelivery = (SHOP_PAID_STATUSES as readonly string[]).includes(order.status) ? buyerEmailView(await getEmailState('tienda', order.id)) : null;
    return NextResponse.json({ ...withoutSeasonLink(order), paymentCheck, emailDelivery });
  } catch (error) {
    return handleApiError(error, 'GET /api/shop/orders/[orderId]');
  }
}
