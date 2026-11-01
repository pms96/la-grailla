export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { baseSlug, createWithUniqueSlug } from '@/lib/slug';
import { planSeasonMove, recordSeasonMove } from '@/lib/contabilidad/season-reassign';
import { seasonLinkEnabled, withoutSeasonLink } from '@/lib/modules/season-link';
import { syncProductVariants } from '@/lib/product-stock';

const variantStockSchema = z.object({
  size: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  stock: z.coerce.number().int().min(0),
});

const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  // 0 = producto gratis; negativo daba pedidos con total negativo. El tope evita desbordar el Decimal(10,2) con un 500.
  price: z.coerce.number().min(0).max(100_000).optional(),
  imageUrl: z.string().optional().nullable(),
  images: z.array(z.string()).optional(),
  category: z.string().optional(),
  sizes: z.string().optional().nullable(),
  colors: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  variants: z.array(variantStockSchema).optional(),
  temporadaId: z.string().optional().nullable(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
      include: { variants: { orderBy: [{ size: 'asc' }, { color: 'asc' }] } },
    });
    return NextResponse.json(withoutSeasonLink(products ?? []));
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
    const slugBase = baseSlug(body?.name, 'producto');
    // H-019: un producto nuevo no entra ya enlazado a una temporada cerrada (cambiaría su margen).
    const seasonMove = body?.temporadaId && seasonLinkEnabled() ? await planSeasonMove(async () => null, body.temporadaId) : null;
    if (seasonMove?.block) return seasonMove.block;
    // H-052: slug libre (`gorra`, `gorra-2`…), también si otra alta simultánea gana la carrera.
    const product = await createWithUniqueSlug(slugBase, async (s) => (await prisma.product.findUnique({ where: { slug: s }, select: { id: true } })) !== null, (slug) => prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: body?.name ?? '',
          slug,
          description: body?.description ?? '',
          price: body?.price ?? 0,
          imageUrl: body?.imageUrl ?? null,
          images: body?.images ?? [],
          category: body?.category ?? '',
          sizes: body?.sizes || null,
          colors: body?.colors || null,
          isActive: body?.isActive ?? true,
          temporadaId: seasonLinkEnabled() ? body?.temporadaId || null : null,
        },
      });
      await syncProductVariants(tx, created.id, created.sizes, created.colors, body.variants);
      return tx.product.findUniqueOrThrow({
        where: { id: created.id },
        include: { variants: { orderBy: [{ size: 'asc' }, { color: 'asc' }] } },
      });
    }));
    return NextResponse.json(product);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/products');
  }
}
