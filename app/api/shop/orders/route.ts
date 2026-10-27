export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPaymentProvider } from '@/lib/payment-adapter';
import { getBaseUrl } from '@/lib/url';
import { getConfig } from '@/lib/config';
import { rateLimit, getClientIp, countPendingSlots, takePendingSlot, releasePendingSlot } from '@/lib/rate-limit';
import { CHECKOUT_RELEASE_AFTER_MS } from '@/lib/checkout-hold';
import { PENDING_LIMIT_CONFIG_KEY, parsePendingLimit, MAX_SHOP_LINES_PER_ORDER, MAX_SHOP_UNITS_PER_LINE, MAX_SHOP_UNITS_PER_ORDER } from '@/lib/checkout-limits';
import { resumeCheckoutUrl } from '@/lib/reconciliation/close-session';
import { handleApiError } from '@/lib/api-error';
import { completeShopOrder } from '@/lib/reconciliation/tienda';
import { reserveShopStock, releaseShopStock } from '@/lib/product-stock';
import { shopOrderAccessQuery, signShopOrderAccess } from '@/lib/access-token';
import { getBrand } from '@/lib/brand/brand';

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
        // Tope por línea: sin él, una sola petición podía reservar todo el stock de un producto.
        quantity: z.number().int().positive().max(MAX_SHOP_UNITS_PER_LINE).optional(),
        size: z.string().optional().nullable(),
        color: z.string().optional().nullable(),
      })
    )
    .min(1)
    .max(MAX_SHOP_LINES_PER_ORDER),
});

// Demasiados pedidos sin pagar a la vez desde la misma IP: 429, porque el cupo se libera solo al pagar o abandonar.
class TooManyPendingOrdersError extends Error {}

/** Respuesta de un reintento con la misma clave de idempotencia: si el pedido sigue PENDING con su sesión abierta, devuelve la URL para reanudarla (TI-12). */
async function existingOrderResponse(existing: { id: string; status: string; paymentProvider: string | null; paymentId: string | null }) {
  return NextResponse.json({
    success: true,
    orderId: existing.id,
    checkoutUrl: await resumeCheckoutUrl('tienda', existing),
    provider: existing.paymentProvider ?? 'mock',
    accessToken: signShopOrderAccess(existing.id),
  });
}

export async function POST(request: Request) {
  try {
    const clientIp = getClientIp(request);
    const limit = await rateLimit('shop-orders', clientIp, 10, 60_000);
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
      if (existing) return existingOrderResponse(existing);
    }

    // Unidades en total por pedido (además del tope por línea y de líneas): sin él, 20 líneas de 10 unidades siguen reservando medio catálogo.
    const totalUnits = items.reduce((sum, i) => sum + (i.quantity ?? 1), 0);
    if (totalUnits > MAX_SHOP_UNITS_PER_ORDER) {
      return NextResponse.json({ error: `Máximo ${MAX_SHOP_UNITS_PER_ORDER} unidades por pedido` }, { status: 400 });
    }

    // ¿Hay pasarela real? Si no (o si no se puede saber), el cupo por IP se aplica igual: el pedido sin pasarela nace pagado y no ocupa hueco.
    const gatewayIsLive = await getPaymentProvider('tienda').then((p) => p.name !== 'mock').catch(() => true);
    const maxPendingPerIp = parsePendingLimit(await getConfig(PENDING_LIMIT_CONFIG_KEY.tienda));

    // DATA-01: derivado del cliente extendido (totalAmount/unitPrice son
    // number), no de Prisma.ShopOrderGetPayload (Decimal, no coincidiría).
    type ShopOrderWithItems = NonNullable<Awaited<ReturnType<typeof prisma.shopOrder.findFirst<{ include: { items: true } }>>>>;
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

        // Cupo de pedidos sin pagar por IP. El recuento + la inserción se serializan con un cerrojo por IP: sin él, N peticiones simultáneas
        // leen el mismo recuento y se cuelan todas (reproducido: 8 POST a la vez con tope 3 dieron 8 pedidos). Es el primer y único cerrojo
        // advisory que toma una compra de tienda, y se toma antes de bloquear ninguna fila de stock: no hay orden de bloqueos invertido
        // con ningún otro camino (la reserva de stock solo bloquea filas de ProductVariant, y los demás caminos de la tienda no toman este cerrojo).
        if (gatewayIsLive) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'shop-pending-slot:' + clientIp}))`;
          if ((await countPendingSlots(tx, 'shop', clientIp)) >= maxPendingPerIp) throw new TooManyPendingOrdersError();
        }

        const stockError = await reserveShopStock(tx, reserveItems);
        if (stockError) {
          throw Object.assign(new Error(stockError), { code: 'OUT_OF_STOCK' as const });
        }

        const created = await tx.shopOrder.create({
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
        if (gatewayIsLive) await takePendingSlot(tx, 'shop', clientIp, created.id, CHECKOUT_RELEASE_AFTER_MS);
        return created;
      });
    } catch (error) {
      if (error instanceof TooManyPendingOrdersError) {
        return NextResponse.json(
          { error: 'Ya tienes pedidos pendientes de pago. Termina el pago o espera unos minutos a que se liberen.' },
          { status: 429, headers: { 'Retry-After': '60' } }
        );
      }
      if (
        idempotencyKey &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        const existing = await prisma.shopOrder.findUnique({ where: { idempotencyKey } });
        if (existing) return existingOrderResponse(existing);
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
    let createdSessionId: string | null = null;
    let paymentProviderForCleanup: Awaited<ReturnType<typeof getPaymentProvider>> | null = null;
    try {
      const baseUrl = getBaseUrl(request);
      const paymentProvider = await getPaymentProvider('tienda');
      const brand = await getBrand();
      provider = paymentProvider.name;
      paymentProviderForCleanup = paymentProvider;
      if (paymentProvider.name !== 'mock' && createdOrder.totalAmount > 0) {
        const session = await paymentProvider.createCheckoutSession({
          amount: createdOrder.totalAmount,
          currency: 'EUR',
          description: `Pedido tienda ${brand.name}`,
          orderId: createdOrder.id,
          successUrl: baseUrl + '/tienda/confirmacion/' + createdOrder.id + '?' + shopOrderAccessQuery(createdOrder.id),
          // Volver atrás desde la pasarela pasa por aquí: libera el stock del pedido si no se ha pagado (con el token firmado del pedido).
          cancelUrl: baseUrl + '/api/shop/orders/' + createdOrder.id + '/abandon?' + shopOrderAccessQuery(createdOrder.id),
          customerEmail: buyerEmail,
          metadata: { orderType: 'shop' },
        });
        checkoutUrl = session?.checkoutUrl ?? null;
        createdSessionId = session?.sessionId ?? null;
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
      // Si la sesión SÍ se creó en la pasarela y lo que falló fue lo de después, se cierra: el pedido se cancela y no debe poder pagarse.
      if (createdSessionId && paymentProviderForCleanup?.cancelPayment) await paymentProviderForCleanup.cancelPayment(createdSessionId).catch(() => {});
      await releasePendingSlot(createdOrder.id);
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

    return NextResponse.json({
      success: true,
      orderId: createdOrder.id,
      checkoutUrl,
      provider,
      accessToken: signShopOrderAccess(createdOrder.id),
    });
  } catch (error) {
    return handleApiError(error, 'POST /api/shop/orders');
  }
}
