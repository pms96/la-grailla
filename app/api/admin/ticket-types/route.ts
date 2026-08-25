export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const createTicketTypeSchema = z.object({
  eventId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.coerce.number().min(0).optional(),
  phase: z.coerce.number().optional(),
  phaseName: z.string().optional(),
  maxQuantity: z.coerce.number().min(0).optional(),
  sortOrder: z.coerce.number().optional(),
  isActive: z.boolean().optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = createTicketTypeSchema.parse(await request.json());
    const tt = await prisma.ticketType.create({
      data: {
        eventId: body?.eventId,
        name: body?.name ?? '',
        description: body?.description ?? '',
        price: body?.price ?? 0,
        phase: body?.phase ?? 1,
        phaseName: body?.phaseName ?? 'General',
        maxQuantity: body?.maxQuantity ?? 100,
        sortOrder: body?.sortOrder ?? 0,
        isActive: body?.isActive ?? true,
      },
    });
    return NextResponse.json(tt);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/ticket-types');
  }
}
