export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateUserSchema = z.object({
  role: z.enum(['ADMIN', 'TAQUILLA', 'USER']).optional(),
  name: z.string().optional().nullable(),
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
    const body = updateUserSchema.parse(await request.json());
    const user = await prisma.user.update({
      where: { id: params?.id },
      data: { role: body?.role, name: body?.name },
      select: { id: true, name: true, email: true, role: true },
    });
    return NextResponse.json(user);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/users/[id]');
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
    await prisma.user.delete({ where: { id: params?.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/users/[id]');
  }
}
