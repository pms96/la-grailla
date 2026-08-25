export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { completeShopOrder } from '@/lib/order-reconciliation';
import { handleApiError } from '@/lib/api-error';

export async function GET(
  _request: Request,
  { params }: { params: { orderId: string } }
) {
  try {
    let order = await prisma.shopOrder.findUnique({
      where: { id: params?.orderId },
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
        const provider = await getPaymentProviderByName(order.paymentProvider);
        const result = await provider.verifyPayment(order.paymentId);
        if (result.success) {
          await completeShopOrder(order.id);
          order = await prisma.shopOrder.findUnique({
            where: { id: order.id },
            include: { items: { include: { product: true } } },
          });
        }
      } catch (error) {
        console.error('Shop payment verification error:', error instanceof Error ? error.message : error);
      }
    }

    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }

    return NextResponse.json(order);
  } catch (error) {
    return handleApiError(error, 'GET /api/shop/orders/[orderId]');
  }
}
