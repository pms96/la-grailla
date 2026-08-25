import type { Prisma } from '@prisma/client';
import { expandVariantKeys } from '@/lib/shop-cart';

export type VariantKey = { size: string; color: string };

export function normalizeVariantPart(value: string | null | undefined): string {
  return (value ?? '').trim();
}

export { expandVariantKeys };

export type StockInput = { size?: string | null; color?: string | null; stock?: number | null };

/**
 * Sincroniza ProductVariant con tallas/colores del producto.
 * Conserva stock de variantes que siguen existiendo; nuevas empiezan en 0
 * (o el valor de `stockByKey` si se pasa).
 */
export async function syncProductVariants(
  tx: Prisma.TransactionClient,
  productId: string,
  sizesCsv: string | null | undefined,
  colorsCsv: string | null | undefined,
  stockByKey?: StockInput[]
): Promise<void> {
  const keys = expandVariantKeys(sizesCsv, colorsCsv);
  const stockMap = new Map<string, number>();
  for (const row of stockByKey ?? []) {
    if (row.stock === undefined || row.stock === null) continue;
    const size = normalizeVariantPart(row.size);
    const color = normalizeVariantPart(row.color);
    stockMap.set(`${size}|${color}`, Math.max(0, Math.floor(Number(row.stock) || 0)));
  }

  const existing = await tx.productVariant.findMany({ where: { productId } });
  const keep = new Set(keys.map((k) => `${k.size}|${k.color}`));

  for (const v of existing) {
    if (!keep.has(`${v.size}|${v.color}`)) {
      await tx.productVariant.delete({ where: { id: v.id } });
    }
  }

  for (const key of keys) {
    const mapKey = `${key.size}|${key.color}`;
    const current = existing.find((v) => v.size === key.size && v.color === key.color);
    const nextStock = stockMap.has(mapKey) ? stockMap.get(mapKey)! : (current?.stock ?? 0);

    if (current) {
      if (stockMap.has(mapKey) && current.stock !== nextStock) {
        await tx.productVariant.update({ where: { id: current.id }, data: { stock: nextStock } });
      }
    } else {
      await tx.productVariant.create({
        data: {
          productId,
          size: key.size,
          color: key.color,
          stock: nextStock,
        },
      });
    }
  }
}

export type ReserveItem = {
  productId: string;
  quantity: number;
  size?: string | null;
  color?: string | null;
};

/**
 * Reserva stock de forma atómica. Si el producto no tiene variantes, no hace nada
 * (compatibilidad con catálogo sin stock configurado).
 * Devuelve mensaje de error en español o null si OK.
 */
export async function reserveShopStock(
  tx: Prisma.TransactionClient,
  items: ReserveItem[]
): Promise<string | null> {
  for (const item of items) {
    const qty = item.quantity;
    if (qty <= 0) continue;

    const variantCount = await tx.productVariant.count({ where: { productId: item.productId } });
    if (variantCount === 0) continue;

    const size = normalizeVariantPart(item.size);
    const color = normalizeVariantPart(item.color);
    const updated = await tx.productVariant.updateMany({
      where: {
        productId: item.productId,
        size,
        color,
        stock: { gte: qty },
      },
      data: { stock: { decrement: qty } },
    });

    if (updated.count === 0) {
      const product = await tx.product.findUnique({
        where: { id: item.productId },
        select: { name: true },
      });
      const label = [product?.name, size, color].filter(Boolean).join(' · ') || 'Producto';
      return `Sin stock suficiente: ${label}`;
    }
  }
  return null;
}

export async function releaseShopStock(
  tx: Prisma.TransactionClient,
  items: ReserveItem[]
): Promise<void> {
  for (const item of items) {
    const qty = item.quantity;
    if (qty <= 0) continue;

    const size = normalizeVariantPart(item.size);
    const color = normalizeVariantPart(item.color);
    await tx.productVariant.updateMany({
      where: { productId: item.productId, size, color },
      data: { stock: { increment: qty } },
    });
  }
}
