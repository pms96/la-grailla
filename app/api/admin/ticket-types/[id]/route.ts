export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateTicketTypeSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  price: z.coerce.number().optional(),
  phase: z.coerce.number().optional(),
  phaseName: z.string().optional().nullable(),
  maxQuantity: z.coerce.number().optional(),
  sortOrder: z.coerce.number().optional(),
  isActive: z.boolean().optional(),
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
    const body = updateTicketTypeSchema.parse(await request.json());
    const tt = await prisma.ticketType.update({
      where: { id: params?.id },
      data: {
        name: body?.name,
        description: body?.description,
        price: body?.price,
        phase: body?.phase,
        phaseName: body?.phaseName,
        maxQuantity: body?.maxQuantity,
        sortOrder: body?.sortOrder,
        isActive: body?.isActive,
      },
    });
    return NextResponse.json(tt);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/ticket-types/[id]');
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    await prisma.ticketType.delete({ where: { id: params?.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/ticket-types/[id]');
  }
}
