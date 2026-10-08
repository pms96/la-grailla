export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';

const patchSchema = z.object({ status: z.enum(['NEW', 'ANSWERED', 'ARCHIVED']) });

async function isAdmin() {
  return (await getServerSession(authOptions))?.user?.role === 'ADMIN';
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const message = await prisma.contactMessage.findUnique({
      where: { id: params.id },
      include: { replies: { orderBy: { createdAt: 'asc' } } },
    });
    if (!message) return NextResponse.json({ error: 'Mensaje no encontrado' }, { status: 404 });
    return NextResponse.json(message);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/contact/[id]');
  }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const { status } = patchSchema.parse(await request.json());
    const res = await prisma.contactMessage.updateMany({ where: { id: params.id }, data: { status } });
    if (res.count === 0) return NextResponse.json({ error: 'Mensaje no encontrado' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/contact/[id]');
  }
}

/** Borrado definitivo (derecho de supresión del interesado). Se llevan consigo sus respuestas. */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const res = await prisma.contactMessage.deleteMany({ where: { id: params.id } });
    if (res.count === 0) return NextResponse.json({ error: 'Mensaje no encontrado' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/contact/[id]');
  }
}
