export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateUserSchema = z.object({
  role: z.enum(['ADMIN', 'TAQUILLA', 'USER']).optional(),
  name: z.string().optional().nullable(),
  password: z.string().min(8, 'password_too_short').optional(),
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

    // Sin este guard, un admin podría quitarse a sí mismo el rol ADMIN (o
    // borrarse, en el DELETE de abajo) y quedarse fuera del panel sin nadie
    // que pueda revertirlo salvo tocando la base de datos a mano.
    if (body?.role && body.role !== 'ADMIN' && params?.id === session.user?.id) {
      return NextResponse.json({ error: 'No puedes quitarte a ti mismo el rol de administrador' }, { status: 400 });
    }
    if (body?.role && body.role !== 'ADMIN') {
      const target = await prisma.user.findUnique({ where: { id: params?.id }, select: { role: true } });
      if (target?.role === 'ADMIN') {
        const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
        if (adminCount <= 1) {
          return NextResponse.json({ error: 'No puedes quitar el último administrador' }, { status: 400 });
        }
      }
    }

    const user = await prisma.user.update({
      where: { id: params?.id },
      data: {
        role: body?.role,
        name: body?.name,
        ...(body?.password ? { hashedPassword: await bcrypt.hash(body.password, 12) } : {}),
      },
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
    if (params?.id === session.user?.id) {
      return NextResponse.json({ error: 'No puedes eliminar tu propia cuenta' }, { status: 400 });
    }
    const target = await prisma.user.findUnique({ where: { id: params?.id }, select: { role: true } });
    if (target?.role === 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        return NextResponse.json({ error: 'No puedes eliminar el último administrador' }, { status: 400 });
      }
    }
    await prisma.user.delete({ where: { id: params?.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/users/[id]');
  }
}
