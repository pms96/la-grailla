export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { getPaymentProvider } from '@/lib/payment-adapter';
import { getBaseUrl } from '@/lib/url';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { handleApiError } from '@/lib/api-error';

const createShopOrderSchema = z.object({
  buyerName: z.string().min(1),
  buyerEmail: z.string().email(),
  shippingAddress: z.string().min(1),
  shippingCity: z.string().min(1),
  shippingZip: z.string().min(1),
  shippingPhone: z.string().optional().nullable(),
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
    const { buyerName, buyerEmail, shippingAddress, shippingCity, shippingZip, shippingPhone, items } = body;

    // Calculate total
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

    const shopOrder = await prisma.shopOrder.create({
      data: {
        buyerName,
        buyerEmail,
        shippingAddress,
        shippingCity,
        shippingZip,
        shippingPhone: shippingPhone ?? null,
        totalAmount,
        status: 'PENDING',
        items: { create: itemsData },
      },
      include: { items: { include: { product: true } } },
    });

    // Send confirmation
    const itemsHtml = (shopOrder.items ?? []).map((i) =>
      `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${i?.product?.name ?? ''}</td><td style="padding:8px;border-bottom:1px solid #eee;">${i?.quantity ?? 0}</td><td style="padding:8px;border-bottom:1px solid #eee;">${(i?.unitPrice ?? 0).toFixed(2)}\u20ac</td></tr>`
    ).join('');

    const emailResult = await sendMail({
      subject: `Pedido confirmado - La Grailla #${shopOrder.id?.slice(0, 8)}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;"><h2 style="color:#a855f7;">Pedido Confirmado</h2><p>Hola ${buyerName},</p><p>Tu pedido ha sido registrado.</p><table style="width:100%;border-collapse:collapse;"><tr style="background:#f3f4f6;"><th style="padding:8px;text-align:left;">Producto</th><th style="padding:8px;">Cant.</th><th style="padding:8px;">Precio</th></tr>${itemsHtml}</table><p style="font-size:18px;font-weight:bold;margin-top:16px;">Total: ${totalAmount.toFixed(2)}\u20ac</p><p style="color:#666;">Te notificaremos cuando tu pedido sea enviado.</p></div>`,
      to: buyerEmail,
    });
    if (!emailResult.success) {
      console.error('Shop order confirmation email failed:', emailResult.error);
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
        });
        checkoutUrl = session?.checkoutUrl ?? null;
        if (session?.sessionId) {
          await prisma.shopOrder.update({
            where: { id: shopOrder.id },
            data: { paymentProvider: session.provider, paymentId: session.sessionId },
          });
        }
      }
    } catch (error) {
      // No dejar que el comprador avance a "confirmación" como si hubiera pagado
      // cuando la pasarela real (no mock) no pudo crear la sesión de cobro.
      console.error('Shop checkout session error:', error instanceof Error ? error.message : error);
      await prisma.shopOrder.update({ where: { id: shopOrder.id }, data: { status: 'CANCELLED' } });
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
