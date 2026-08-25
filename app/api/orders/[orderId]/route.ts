export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { completeOrder } from '@/lib/order-reconciliation';
import { getBaseUrl } from '@/lib/url';
import { handleApiError } from '@/lib/api-error';

const includeTicketsAndEvent = { event: true, tickets: { include: { ticketType: true } } } as const;

export async function GET(
  request: Request,
  { params }: { params: { orderId: string } }
) {
  try {
    let order = await prisma.order.findUnique({
      where: { id: params?.orderId },
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
          await completeOrder(order.id, getBaseUrl(request));
          order = await prisma.order.findUnique({ where: { id: order.id }, include: includeTicketsAndEvent });
        }
      } catch (error) {
        console.error('Payment verification error:', error instanceof Error ? error.message : error);
      }
    }

    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }

    return NextResponse.json(order);
  } catch (error) {
    return handleApiError(error, 'GET /api/orders/[orderId]');
  }
}
