export const dynamic = 'force-dynamic';

import { isFullAccessRestricted } from '@/lib/modules/runtime';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { invalidateOrder, completeOrder } from '@/lib/reconciliation/entradas';
import { sendRefundEmail } from '@/lib/reconciliation/gateway-refund';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { getBaseUrl } from '@/lib/url';
import { getEmailState } from '@/lib/email-delivery';
import { adminEmailView } from '@/lib/order-email';
import { actorFromSession, recordAdminAuditSafe, type AuditAction } from '@/lib/admin-audit';

const ORDER_AUDIT_ACTION: Record<'cancel' | 'refund' | 'verify' | 'complete' | 'update-email', AuditAction> = {
  cancel: 'order.cancel',
  refund: 'order.refund',
  verify: 'order.verify',
  complete: 'order.complete',
  'update-email': 'order.update_email',
};

const updateOrderSchema = z.object({
  action: z.enum(['cancel', 'refund', 'verify', 'complete', 'update-email']),
  email: z.string().trim().email().optional(),
});

const orderInclude = {
  event: { select: { id: true, name: true, date: true, venue: true, city: true } },
  tickets: {
    include: { ticketType: { select: { id: true, name: true, price: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  invitation: { select: { id: true, guestName: true, listId: true } },
} as const;

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const order = await prisma.order.findUnique({
      where: { id: params?.id },
      include: orderInclude,
    });
    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }
    return NextResponse.json({ ...order, emailDelivery: adminEmailView(await getEmailState('entradas', order.id)) });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/orders/[id]');
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = updateOrderSchema.parse(await request.json());
    // Lo que queda en el registro de auditoría si la acción sale bien (sin datos personales: ni emails ni nombres).
    let auditMeta: Record<string, unknown> = {};

    // El middleware deja pasar este PATCH aunque la licencia esté vencida o falte el módulo, para no frenar un reembolso. Cancelar y
    // reembolsar es dinero ya cobrado; completar un pedido, emitir entradas o cambiar el email del comprador no lo es.
    if (body.action !== 'cancel' && body.action !== 'refund' && isFullAccessRestricted('entradas')) {
      return NextResponse.json({ error: 'Licencia vencida o módulo no disponible' }, { status: 402 });
    }

    if (body.action === 'cancel' || body.action === 'refund') {
      const mode = body.action === 'refund' ? 'REFUNDED' : 'CANCELLED';
      const before = mode === 'REFUNDED' ? await prisma.order.findUnique({ where: { id: params?.id }, select: { id: true, buyerName: true, buyerEmail: true, totalAmount: true, paymentMethod: true, paymentProvider: true, paymentId: true } }) : null;
      const result = await invalidateOrder(params?.id, mode);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 422 });
      }
      if (before) auditMeta = { totalAmount: Number(before.totalAmount), paymentMethod: before.paymentMethod, paymentProvider: before.paymentProvider };
      // EN-08.6: el comprador no se enteraba del reembolso. Solo si de verdad se le devolvió dinero por la pasarela (no en efectivo, datáfono ni simulado).
      if (before && before.paymentMethod === 'CARD' && before.paymentProvider && before.paymentProvider !== 'mock' && before.paymentId) {
        await sendRefundEmail('entradas', before, Number(before.totalAmount));
      }
    } else if (body.action === 'verify') {
      const existing = await prisma.order.findUnique({ where: { id: params?.id } });
      if (!existing) {
        return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
      }
      if (existing.status !== 'PENDING') {
        return NextResponse.json({ error: 'Este pedido ya no está pendiente' }, { status: 422 });
      }
      if (!existing.paymentProvider || !existing.paymentId || existing.paymentProvider === 'mock') {
        return NextResponse.json(
          { error: 'Este pedido no tiene un pago asociado en la pasarela para verificar — usa "Marcar como pagado" si tienes prueba del cobro.' },
          { status: 422 }
        );
      }
      let paid: { amount?: number; currency?: string } | undefined;
      try {
        const provider = await getPaymentProviderByName(existing.paymentProvider);
        const verification = await provider.verifyPayment(existing.paymentId);
        if (!verification.success) {
          return NextResponse.json(
            { error: verification.error || 'La pasarela no confirma el pago de este pedido todavía.' },
            { status: 422 }
          );
        }
        paid = { amount: verification.amount, currency: verification.currency };
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'Error al consultar la pasarela de pago' },
          { status: 422 }
        );
      }
      await completeOrder(params?.id, getBaseUrl(request), paid);
    } else if (body.action === 'complete') {
      // Marcado manual — el admin ya ha comprobado el cobro fuera de la app
      // (extracto bancario, panel de Stripe...), normalmente porque el
      // webhook no llegó o no se pudo verificar automáticamente. No repite
      // la verificación contra la pasarela: completeOrder ya es idempotente
      // (updateMany condicionado a PENDING) y solo actúa una vez.
      const existing = await prisma.order.findUnique({ where: { id: params?.id } });
      if (!existing) {
        return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
      }
      if (existing.status !== 'PENDING') {
        return NextResponse.json({ error: 'Este pedido ya no está pendiente' }, { status: 422 });
      }
      await completeOrder(params?.id, getBaseUrl(request));
    } else if (body.action === 'update-email') {
      if (!body.email) {
        return NextResponse.json({ error: 'Introduce un email válido' }, { status: 422 });
      }
      const existing = await prisma.order.findUnique({ where: { id: params?.id } });
      if (!existing) {
        return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
      }
      await prisma.order.update({ where: { id: params?.id }, data: { buyerEmail: body.email } });
    }

    // Solo se llega aquí si la acción salió bien (los fallos devuelven antes). Sin lanzar: el dinero o el estado ya se movió.
    await recordAdminAuditSafe(actorFromSession(session), request, {
      action: ORDER_AUDIT_ACTION[body.action],
      targetType: 'Order',
      targetId: params?.id,
      meta: body.action === 'update-email' ? { campo: 'buyerEmail' } : auditMeta,
    });
    const order = await prisma.order.findUnique({
      where: { id: params?.id },
      include: orderInclude,
    });
    return NextResponse.json(order ? { ...order, emailDelivery: adminEmailView(await getEmailState('entradas', order.id)) } : order);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/orders/[id]');
  }
}
