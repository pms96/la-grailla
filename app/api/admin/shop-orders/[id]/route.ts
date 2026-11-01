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
import { planSeasonMove, recordSeasonMove } from '@/lib/contabilidad/season-reassign';
import { seasonLinkEnabled } from '@/lib/modules/season-link';
import { isFullAccessRestricted } from '@/lib/modules/runtime';
import { canChangeShopOrderStatus } from '@/lib/shop-order-status';
import { sendShopShippedEmail } from '@/lib/shop/shop-notices';
import { sendRefundEmail } from '@/lib/reconciliation/gateway-refund';
import { actorFromSession, recordAdminAudit, recordAdminAuditSafe } from '@/lib/admin-audit';

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

    // El middleware deja pasar este PUT aunque la licencia esté vencida o falte el módulo, para no frenar un reembolso (H-066). Cancelar y reembolsar es
    // dinero ya cobrado; cambiar el estado a otra cosa, el seguimiento, las notas o la temporada no lo es.
    const isMoneyAction = body.status === 'CANCELLED' || body.status === 'REFUNDED';
    if (!isMoneyAction && isFullAccessRestricted('tienda')) {
      return NextResponse.json({ error: 'Licencia vencida o módulo no disponible' }, { status: 402 });
    }

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
      // Cancelar o reembolsar es dinero: queda quién lo hizo (OB-12). Sin datos personales del comprador.
      await recordAdminAuditSafe(actorFromSession(session), request, {
        action: body.status === 'REFUNDED' ? 'order.shop_refund' : 'order.shop_cancel',
        targetType: 'ShopOrder',
        targetId: params?.id,
        meta: { totalAmount: order ? Number(order.totalAmount) : null, paymentProvider: order?.paymentProvider ?? null },
      });
      // EN-08.6 / TI-08: aviso al comprador del reembolso, solo si se le devolvió dinero por la pasarela.
      if (order && before && before.paymentProvider && before.paymentProvider !== 'mock' && before.paymentId) {
        await sendRefundEmail('tienda', order, Number(order.totalAmount));
      }
      return NextResponse.json(order);
    }

    // H-019: mover el pedido a o desde una temporada cerrada da 423; entre abiertas queda en la auditoría.
    const seasonMove = body?.temporadaId !== undefined && seasonLinkEnabled() ? await planSeasonMove(async () => (await prisma.shopOrder.findUnique({ where: { id: params?.id }, select: { temporadaId: true } }))?.temporadaId, body.temporadaId) : null;
    if (seasonMove?.block) return seasonMove.block;

    // Cambio de estado "plano": solo transiciones con sentido (ver canChangeShopOrderStatus).
    const current = await prisma.shopOrder.findUnique({ where: { id: params?.id }, select: { status: true, trackingNumber: true } });
    if (body?.status !== undefined && current && !canChangeShopOrderStatus(current.status, body.status)) {
      return NextResponse.json({ error: `Un pedido ${current.status} no puede pasar a ${body.status}.` }, { status: 422 });
    }

    // H-018: un cambio de estado «plano» (sobre todo PENDING→PAID a mano, sin pasar por la pasarela) es dinero declarado por una persona: queda quién y
    // cuándo, en la MISMA transacción que el cambio (H-021). Solo el estado: el seguimiento y las notas no son dinero.
    const statusChange = body?.status !== undefined && current && body.status !== current.status ? { from: current.status, to: body.status } : null;
    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.shopOrder.update({
        where: { id: params?.id },
        data: {
          status: body?.status,
          trackingNumber: body?.trackingNumber,
          notes: body?.notes,
          temporadaId: body?.temporadaId === undefined || !seasonLinkEnabled() ? undefined : body.temporadaId || null,
        },
      });
      if (statusChange) {
        await recordAdminAudit(tx, actorFromSession(session), request, {
          action: 'order.shop_status',
          targetType: 'ShopOrder',
          targetId: updated.id,
          meta: { totalAmount: Number(updated.totalAmount), cambios: { status: statusChange } },
        });
      }
      return updated;
    });

    await recordSeasonMove(seasonMove, { session, request, targetType: 'ShopOrder', targetId: params?.id });

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
