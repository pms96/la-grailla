export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { invalidateOrder, completeOrder } from '@/lib/order-reconciliation';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { getBaseUrl } from '@/lib/url';

const updateOrderSchema = z.object({
  action: z.enum(['cancel', 'refund', 'verify', 'complete']),
});

const orderInclude = {
  event: { select: { id: true, name: true, date: true, venue: true, city: true } },
  tickets: {
    include: { ticketType: { select: { id: true, name: true, price: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  invitation: { select: { id: true, guestName: true, listId: true } },
} as const;

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
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
    return NextResponse.json(order);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/orders/[id]');
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = updateOrderSchema.parse(await request.json());

    if (body.action === 'cancel' || body.action === 'refund') {
      const mode = body.action === 'refund' ? 'REFUNDED' : 'CANCELLED';
      const result = await invalidateOrder(params?.id, mode);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 422 });
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
      try {
        const provider = await getPaymentProviderByName(existing.paymentProvider);
        const verification = await provider.verifyPayment(existing.paymentId);
        if (!verification.success) {
          return NextResponse.json(
            { error: verification.error || 'La pasarela no confirma el pago de este pedido todavía.' },
            { status: 422 }
          );
        }
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'Error al consultar la pasarela de pago' },
          { status: 422 }
        );
      }
      await completeOrder(params?.id, getBaseUrl(request));
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
    }

    const order = await prisma.order.findUnique({
      where: { id: params?.id },
      include: orderInclude,
    });
    return NextResponse.json(order);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/orders/[id]');
  }
}
