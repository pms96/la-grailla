export const dynamic = 'force-dynamic';
// El email de envío sale en la propia petición (tope duro de 15 s).
export const maxDuration = 30;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { invalidateShopOrder } from '@/lib/reconciliation/tienda';
import { seasonLinkEnabled } from '@/lib/modules/season-link';
import { canChangeShopOrderStatus } from '@/lib/shop-order-status';
import { sendShopShippedEmail } from '@/lib/shop/shop-notices';
import { sendRefundEmail } from '@/lib/reconciliation/gateway-refund';

const updateShopOrderSchema = z.object({
  status: z.enum(['PENDING', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']).optional(),
  trackingNumber: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  temporadaId: z.string().optional().nullable(),
  /** Volver a enviar al comprador el aviso de envío (el pedido debe estar «Enviado»). */
  resendShippedEmail: z.boolean().optional(),
});

export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = updateShopOrderSchema.parse(await request.json());

    // Cancelar/reembolsar tiene lógica de negocio propia (liberar stock, y
    // en reembolso intentar devolver el dinero en la pasarela primero) — no
    // es un simple cambio de campo, así que pasa por invalidateShopOrder en
    // vez del update plano de abajo.
    if (body?.status === 'CANCELLED' || body?.status === 'REFUNDED') {
      const before = body.status === 'REFUNDED' ? await prisma.shopOrder.findUnique({ where: { id: params?.id }, select: { paymentProvider: true, paymentId: true } }) : null;
      const result = await invalidateShopOrder(params?.id, body.status);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 422 });
      }
      const order = await prisma.shopOrder.findUnique({ where: { id: params?.id } });
      // EN-08.6 / TI-08: aviso al comprador del reembolso, solo si se le devolvió dinero por la pasarela.
      if (order && before && before.paymentProvider && before.paymentProvider !== 'mock' && before.paymentId) {
        await sendRefundEmail('tienda', order, Number(order.totalAmount));
      }
      return NextResponse.json(order);
    }

    // Cambio de estado "plano": solo transiciones con sentido (ver canChangeShopOrderStatus).
    const current = await prisma.shopOrder.findUnique({ where: { id: params?.id }, select: { status: true, trackingNumber: true } });
    if (body?.status !== undefined && current && !canChangeShopOrderStatus(current.status, body.status)) {
      return NextResponse.json({ error: `Un pedido ${current.status} no puede pasar a ${body.status}.` }, { status: 422 });
    }

    const order = await prisma.shopOrder.update({
      where: { id: params?.id },
      data: {
        status: body?.status,
        trackingNumber: body?.trackingNumber,
        notes: body?.notes,
        temporadaId: body?.temporadaId === undefined || !seasonLinkEnabled() ? undefined : body.temporadaId || null,
      },
    });

    // P1-10: al pasar a «Enviado» el comprador recibe un email con su enlace y el seguimiento; si el número llega o cambia después, otro con el nuevo.
    // `resendShippedEmail` (botón del admin) lo vuelve a enviar. El fallo del correo NO deshace el cambio de estado: se devuelve para avisar al admin.
    const nowTracking = (order.trackingNumber ?? '').trim();
    const becameShipped = order.status === 'SHIPPED' && current?.status !== 'SHIPPED';
    const trackingArrived = order.status === 'SHIPPED' && body?.trackingNumber !== undefined && nowTracking !== '' && nowTracking !== (current?.trackingNumber ?? '').trim();
    const shippedEmail = becameShipped || trackingArrived || body?.resendShippedEmail ? await sendShopShippedEmail(order.id, { force: body?.resendShippedEmail === true }) : undefined;
    return NextResponse.json({ ...order, shippedEmail });
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/shop-orders/[id]');
  }
}
