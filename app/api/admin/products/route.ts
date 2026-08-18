export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.coerce.number().optional(),
  imageUrl: z.string().optional().nullable(),
  category: z.string().optional(),
  sizes: z.string().optional().nullable(),
  colors: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
    return NextResponse.json(products ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/products');
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = createProductSchema.parse(await request.json());
    const slug = (body?.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const product = await prisma.product.create({
      data: {
        name: body?.name ?? '',
        slug,
        description: body?.description ?? '',
        price: body?.price ?? 0,
        imageUrl: body?.imageUrl ?? null,
        category: body?.category ?? '',
        sizes: body?.sizes || null,
        colors: body?.colors || null,
        isActive: body?.isActive ?? true,
      },
    });
    return NextResponse.json(product);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/products');
  }
}
