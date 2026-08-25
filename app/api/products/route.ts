export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';

export async function GET() {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
      include: {
        variants: {
          select: { id: true, size: true, color: true, stock: true },
          orderBy: [{ size: 'asc' }, { color: 'asc' }],
        },
      },
    });
    return NextResponse.json(products ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/products');
  }
}
