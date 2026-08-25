export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { syncProductVariants } from '@/lib/product-stock';

const variantStockSchema = z.object({
  size: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  stock: z.coerce.number().int().min(0),
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  price: z.coerce.number().optional(),
  imageUrl: z.string().optional().nullable(),
  images: z.array(z.string()).optional(),
  category: z.string().optional().nullable(),
  sizes: z.string().optional().nullable(),
  colors: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  variants: z.array(variantStockSchema).optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateProductSchema.parse(await request.json());
    const product = await prisma.$transaction(async (tx) => {
      const data: Prisma.ProductUpdateInput = {};
      if (body?.name !== undefined) data.name = body.name;
      if (body?.description !== undefined) data.description = body.description;
      if (body?.price !== undefined) data.price = Number(body.price) || 0;
      if (body?.imageUrl !== undefined) data.imageUrl = body.imageUrl || null;
      if (body?.images !== undefined) data.images = body.images;
      if (body?.category !== undefined) data.category = body.category;
      if (body?.sizes !== undefined) data.sizes = body.sizes || null;
      if (body?.colors !== undefined) data.colors = body.colors || null;
      if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive);

      const updated = await tx.product.update({ where: { id: params?.id }, data });
      if (
        body?.sizes !== undefined ||
        body?.colors !== undefined ||
        body?.variants !== undefined
      ) {
        await syncProductVariants(tx, updated.id, updated.sizes, updated.colors, body.variants);
      }
      return tx.product.findUniqueOrThrow({
        where: { id: updated.id },
        include: { variants: { orderBy: [{ size: 'asc' }, { color: 'asc' }] } },
      });
    });
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
