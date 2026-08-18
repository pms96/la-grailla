export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  price: z.coerce.number().optional(),
  imageUrl: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  sizes: z.string().optional().nullable(),
  colors: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateProductSchema.parse(await request.json());
    const data: Prisma.ProductUpdateInput = {};
    if (body?.name !== undefined) data.name = body.name;
    if (body?.description !== undefined) data.description = body.description;
    if (body?.price !== undefined) data.price = Number(body.price) || 0;
    if (body?.imageUrl !== undefined) data.imageUrl = body.imageUrl || null;
    if (body?.category !== undefined) data.category = body.category;
    if (body?.sizes !== undefined) data.sizes = body.sizes || null;
    if (body?.colors !== undefined) data.colors = body.colors || null;
    if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive);

    const product = await prisma.product.update({ where: { id: params?.id }, data });
    return NextResponse.json(product);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/products/[id]');
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    await prisma.product.update({ where: { id: params?.id }, data: { isActive: false } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/products/[id]');
  }
}
