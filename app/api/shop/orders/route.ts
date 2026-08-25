export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPaymentProvider } from '@/lib/payment-adapter';
import { getBaseUrl } from '@/lib/url';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { handleApiError } from '@/lib/api-error';
import { completeShopOrder } from '@/lib/order-reconciliation';

const createShopOrderSchema = z.object({
  buyerName: z.string().min(1),
  buyerEmail: z.string().email(),
  shippingAddress: z.string().min(1),
  shippingCity: z.string().min(1),
  shippingZip: z.string().min(1),
  shippingPhone: z.string().optional().nullable(),
  idempotencyKey: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().positive().optional(),
        size: z.string().optional().nullable(),
        color: z.string().optional().nullable(),
      })
    )
    .min(1),
});

export async function POST(request: Request) {
  try {
    const limit = await rateLimit('shop-orders', getClientIp(request), 10, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Has realizado demasiados intentos. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const body = createShopOrderSchema.parse(await request.json());
    const {
      buyerName,
      buyerEmail,
      shippingAddress,
      shippingCity,
      shippingZip,
      shippingPhone,
      items,
      idempotencyKey,
    } = body;

    if (idempotencyKey) {
      const existing = await prisma.shopOrder.findUnique({ where: { idempotencyKey } });
      if (existing) {
        return NextResponse.json({
          success: true,
          orderId: existing.id,
          checkoutUrl: null,
          provider: existing.paymentProvider ?? 'mock',
        });
      }
    }

    let totalAmount = 0;
    const itemsData: Prisma.ShopOrderItemUncheckedCreateWithoutShopOrderInput[] = [];
    for (const item of items) {
      const product = await prisma.product.findUnique({ where: { id: item?.productId } });
      if (!product) continue;
      const qty = item?.quantity ?? 1;
      totalAmount += (product?.price ?? 0) * qty;
      itemsData.push({
        productId: product.id,
        quantity: qty,
        unitPrice: product?.price ?? 0,
        size: item?.size ?? null,
        color: item?.color ?? null,
      });
    }

    if (itemsData.length === 0) {
      return NextResponse.json({ error: 'No hay productos válidos en el pedido' }, { status: 400 });
    }

    let shopOrder;
    try {
      shopOrder = await prisma.shopOrder.create({
        data: {
          buyerName,
          buyerEmail,
          shippingAddress,
          shippingCity,
          shippingZip,
          shippingPhone: shippingPhone ?? null,
          totalAmount,
          status: 'PENDING',
          idempotencyKey: idempotencyKey ?? null,
          items: { create: itemsData },
        },
      });
    } catch (error) {
      if (
        idempotencyKey &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        const existing = await prisma.shopOrder.findUnique({ where: { idempotencyKey } });
        if (existing) {
          return NextResponse.json({
            success: true,
            orderId: existing.id,
            checkoutUrl: null,
            provider: existing.paymentProvider ?? 'mock',
          });
        }
      }
      throw error;
    }

    let checkoutUrl: string | null = null;
    let provider = 'mock';
    try {
      const baseUrl = getBaseUrl(request);
      const paymentProvider = await getPaymentProvider();
      provider = paymentProvider.name;
      if (paymentProvider.name !== 'mock' && totalAmount > 0) {
        const session = await paymentProvider.createCheckoutSession({
          amount: totalAmount,
          currency: 'EUR',
          description: 'Pedido tienda La Grailla',
          orderId: shopOrder.id,
          successUrl: baseUrl + '/tienda/confirmacion/' + shopOrder.id,
          cancelUrl: baseUrl + '/tienda',
          customerEmail: buyerEmail,
          metadata: { orderType: 'shop' },
        });
        checkoutUrl = session?.checkoutUrl ?? null;
        if (session?.sessionId) {
          await prisma.shopOrder.update({
            where: { id: shopOrder.id },
            data: { paymentProvider: session.provider, paymentId: session.sessionId },
          });
        }
      } else {
        // Mock o importe 0: no hay pasarela real — marcar pagado y enviar email aquí.
        await prisma.shopOrder.update({
          where: { id: shopOrder.id },
          data: { paymentProvider: provider },
        });
        await completeShopOrder(shopOrder.id);
      }
    } catch (error) {
      console.error('Shop checkout session error:', error instanceof Error ? error.message : error);
      await prisma.shopOrder.update({
        where: { id: shopOrder.id },
        data: { status: 'CANCELLED', idempotencyKey: null },
      });
      return NextResponse.json(
        { success: false, error: 'No se ha podido iniciar el pago. Inténtalo de nuevo en unos minutos.' },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, orderId: shopOrder.id, checkoutUrl, provider });
  } catch (error) {
    return handleApiError(error, 'POST /api/shop/orders');
  }
}
