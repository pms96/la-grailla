export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateShopOrderSchema = z.object({
  status: z.enum(['PENDING', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']).optional(),
  trackingNumber: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
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
    const order = await prisma.shopOrder.update({
      where: { id: params?.id },
      data: {
        status: body?.status,
        trackingNumber: body?.trackingNumber,
        notes: body?.notes,
      },
    });
    return NextResponse.json(order);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/shop-orders/[id]');
  }
}
