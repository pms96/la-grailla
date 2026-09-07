export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { invalidateShopOrder } from '@/lib/order-reconciliation';

const updateShopOrderSchema = z.object({
  status: z.enum(['PENDING', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']).optional(),
  trackingNumber: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  temporadaId: z.string().optional().nullable(),
});

export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
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
      const result = await invalidateShopOrder(params?.id, body.status);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 422 });
      }
      const order = await prisma.shopOrder.findUnique({ where: { id: params?.id } });
      return NextResponse.json(order);
    }

    const order = await prisma.shopOrder.update({
      where: { id: params?.id },
      data: {
        status: body?.status,
        trackingNumber: body?.trackingNumber,
        notes: body?.notes,
        temporadaId: body?.temporadaId === undefined ? undefined : body.temporadaId || null,
      },
    });
    return NextResponse.json(order);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/shop-orders/[id]');
  }
}
