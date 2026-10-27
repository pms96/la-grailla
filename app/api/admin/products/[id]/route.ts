export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { seasonLinkEnabled } from '@/lib/modules/season-link';
import { StockConflictError, syncProductVariants } from '@/lib/product-stock';
import { releaseUnusedBlobs } from '@/lib/blob-cleanup';

const variantStockSchema = z.object({
  size: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  stock: z.coerce.number().int().min(0).optional(),
  // Stock que el admin veía al abrir el formulario: con él, el cambio solo se aplica si el stock actual sigue siendo ese (409 si no).
  expectedStock: z.number().int().min(0).optional(),
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  price: z.coerce.number().min(0).max(100_000).optional(),
  imageUrl: z.string().optional().nullable(),
  images: z.array(z.string()).optional(),
  category: z.string().optional().nullable(),
  sizes: z.string().optional().nullable(),
  colors: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  variants: z.array(variantStockSchema).optional(),
  temporadaId: z.string().optional().nullable(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateProductSchema.parse(await request.json());
    // Si cambian las fotos, las que sobran se borran de Blob cuando ya está guardado el cambio.
    const previous =
      body?.imageUrl !== undefined || body?.images !== undefined
        ? await prisma.product.findUnique({ where: { id: params?.id }, select: { imageUrl: true, images: true } })
        : null;
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
      if (body?.temporadaId !== undefined && seasonLinkEnabled()) {
        data.temporada = body.temporadaId ? { connect: { id: body.temporadaId } } : { disconnect: true };
      }

      const updated = await tx.product.update({ where: { id: params?.id }, data });
      // Solo se sincronizan variantes si el cliente manda explícitamente `variants`.
      // Antes se disparaba también con solo enviar `sizes`/`colors` (que el
      // formulario de admin manda siempre en cada guardado), lo que reseteaba a 0
      // el stock de productos que aún no tenían filas ProductVariant creadas —
      // app/admin/productos/page.tsx ahora omite `variants` cuando no hay
      // cambios reales de stock/tallas/colores que sincronizar.
      if (body?.variants !== undefined) {
        await syncProductVariants(tx, updated.id, updated.sizes, updated.colors, body.variants);
      }
      return tx.product.findUniqueOrThrow({
        where: { id: updated.id },
        include: { variants: { orderBy: [{ size: 'asc' }, { color: 'asc' }] } },
      });
    });
    if (previous) await releaseUnusedBlobs([previous.imageUrl, ...previous.images], [product.imageUrl, ...product.images]);
    return NextResponse.json(product);
  } catch (error) {
    // La transacción ya se ha deshecho entera: ni el stock ni el resto de campos del producto se han guardado.
    if (error instanceof StockConflictError) {
      return NextResponse.json(
        { error: error.message, code: 'stock_conflict', conflicts: error.conflicts },
        { status: 409 }
      );
    }
    return handleApiError(error, 'PATCH /api/admin/products/[id]');
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    await prisma.product.update({ where: { id: params?.id }, data: { isActive: false } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/products/[id]');
  }
}
