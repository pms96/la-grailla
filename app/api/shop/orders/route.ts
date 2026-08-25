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
import { reserveShopStock, releaseShopStock } from '@/lib/product-stock';

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

    type ShopOrderWithItems = Prisma.ShopOrderGetPayload<{ include: { items: true } }>;
    let shopOrder: ShopOrderWithItems | undefined;
    try {
      shopOrder = await prisma.$transaction(async (tx) => {
        let totalAmount = 0;
        const itemsData: Prisma.ShopOrderItemUncheckedCreateWithoutShopOrderInput[] = [];
        const reserveItems: { productId: string; quantity: number; size?: string | null; color?: string | null }[] = [];

        for (const item of items) {
          const product = await tx.product.findUnique({ where: { id: item?.productId } });
          if (!product || !product.isActive) continue;
          const qty = item?.quantity ?? 1;
          totalAmount += (product?.price ?? 0) * qty;
          itemsData.push({
            productId: product.id,
            quantity: qty,
            unitPrice: product?.price ?? 0,
            size: item?.size ?? null,
            color: item?.color ?? null,
          });
          reserveItems.push({
            productId: product.id,
            quantity: qty,
            size: item?.size,
            color: item?.color,
          });
        }

        if (itemsData.length === 0) {
          throw new Error('NO_VALID_ITEMS');
        }

        const stockError = await reserveShopStock(tx, reserveItems);
        if (stockError) {
          throw Object.assign(new Error(stockError), { code: 'OUT_OF_STOCK' as const });
        }

        return tx.shopOrder.create({
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
          include: { items: true },
        });
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
      if (error instanceof Error && error.message === 'NO_VALID_ITEMS') {
        return NextResponse.json({ error: 'No hay productos válidos en el pedido' }, { status: 400 });
      }
      if (
        error instanceof Error &&
        'code' in error &&
        (error as Error & { code?: string }).code === 'OUT_OF_STOCK'
      ) {
        return NextResponse.json(
          { error: error.message || 'Sin stock suficiente' },
          { status: 409 }
        );
      }
      throw error;
    }

    if (!shopOrder) {
      return NextResponse.json({ error: 'No se pudo crear el pedido' }, { status: 500 });
    }
    const createdOrder = shopOrder;

    let checkoutUrl: string | null = null;
    let provider = 'mock';
    try {
      const baseUrl = getBaseUrl(request);
      const paymentProvider = await getPaymentProvider();
      provider = paymentProvider.name;
      if (paymentProvider.name !== 'mock' && createdOrder.totalAmount > 0) {
        const session = await paymentProvider.createCheckoutSession({
          amount: createdOrder.totalAmount,
          currency: 'EUR',
          description: 'Pedido tienda La Grailla',
          orderId: createdOrder.id,
          successUrl: baseUrl + '/tienda/confirmacion/' + createdOrder.id,
          cancelUrl: baseUrl + '/tienda',
          customerEmail: buyerEmail,
          metadata: { orderType: 'shop' },
        });
        checkoutUrl = session?.checkoutUrl ?? null;
        if (session?.sessionId) {
          await prisma.shopOrder.update({
            where: { id: createdOrder.id },
            data: { paymentProvider: session.provider, paymentId: session.sessionId },
          });
        }
      } else {
        await prisma.shopOrder.update({
          where: { id: createdOrder.id },
          data: { paymentProvider: provider },
        });
        await completeShopOrder(createdOrder.id);
      }
    } catch (error) {
      console.error('Shop checkout session error:', error instanceof Error ? error.message : error);
      await prisma.$transaction(async (tx) => {
        await releaseShopStock(
          tx,
          (createdOrder.items ?? []).map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            size: i.size,
            color: i.color,
          }))
        );
        await tx.shopOrder.update({
          where: { id: createdOrder.id },
          data: { status: 'CANCELLED', idempotencyKey: null },
        });
      });
      return NextResponse.json(
        { success: false, error: 'No se ha podido iniciar el pago. Inténtalo de nuevo en unos minutos.' },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, orderId: createdOrder.id, checkoutUrl, provider });
  } catch (error) {
    return handleApiError(error, 'POST /api/shop/orders');
  }
}
