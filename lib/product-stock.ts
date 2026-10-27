import type { PrismaTransactionClient } from '@/lib/prisma';
import { expandVariantKeys } from '@/lib/shop-cart';

export type VariantKey = { size: string; color: string };

export function normalizeVariantPart(value: string | null | undefined): string {
  return (value ?? '').trim();
}

export { expandVariantKeys };

/**
 * `expectedStock` = el stock que el administrador VIO al abrir el formulario. Si viene, el cambio es optimista: solo se aplica si el
 * stock actual sigue siendo ese (las ventas hechas entre medias no se pisan). Sin él, `stock` se escribe como valor absoluto (alta de una
 * variante nueva, creación del producto, scripts).
 */
export type StockInput = {
  size?: string | null;
  color?: string | null;
  stock?: number | null;
  expectedStock?: number | null;
};

export type StockConflict = { size: string; color: string; expected: number; current: number | null };

/** El stock de una o más variantes cambió desde que el administrador lo cargó: no se ha guardado nada. */
export class StockConflictError extends Error {
  constructor(
    public readonly productName: string,
    public readonly conflicts: StockConflict[]
  ) {
    super(stockConflictMessage(productName, conflicts));
    this.name = 'StockConflictError';
  }
}

function stockConflictMessage(productName: string, conflicts: StockConflict[]): string {
  const detail = conflicts
    .map((c) => {
      const label = [c.size, c.color].filter(Boolean).join(' · ') || 'Única';
      return c.current === null
        ? `${label} (ya no existe; tú veías ${c.expected})`
        : `${label}: ahora hay ${c.current} (tú veías ${c.expected})`;
    })
    .join('; ');
  return `El stock de «${productName}» ha cambiado mientras editabas (probablemente por ventas) y no se ha guardado nada. ${detail}. Revisa los valores y vuelve a guardar.`;
}

/**
 * Sincroniza ProductVariant con tallas/colores del producto.
 * Conserva stock de variantes que siguen existiendo; nuevas empiezan en 0
 * (o el valor de `stockByKey` si se pasa). Las filas de `stockByKey` con `expectedStock` se aplican con control optimista: si alguna
 * ya no coincide con la base de datos lanza StockConflictError (dentro de una transacción, deshace también el resto del guardado).
 */
export async function syncProductVariants(
  tx: PrismaTransactionClient,
  productId: string,
  sizesCsv: string | null | undefined,
  colorsCsv: string | null | undefined,
  stockByKey?: StockInput[]
): Promise<void> {
  const keys = expandVariantKeys(sizesCsv, colorsCsv);
  const stockMap = new Map<string, number>();
  const expectedMap = new Map<string, number>();
  for (const row of stockByKey ?? []) {
    if (row.stock === undefined || row.stock === null) continue;
    const size = normalizeVariantPart(row.size);
    const color = normalizeVariantPart(row.color);
    stockMap.set(`${size}|${color}`, Math.max(0, Math.floor(Number(row.stock) || 0)));
    if (row.expectedStock !== undefined && row.expectedStock !== null) {
      expectedMap.set(`${size}|${color}`, Math.max(0, Math.floor(Number(row.expectedStock) || 0)));
    }
  }
  const conflicts: StockConflict[] = [];

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
      if (expectedMap.has(mapKey)) {
        const expected = expectedMap.get(mapKey)!;
        if (expected === nextStock) continue; // el admin no ha cambiado nada: no se escribe
        // UPDATE condicionado: si una venta cambió el stock desde que se cargó el formulario, no coincide y no se pisa.
        const updated = await tx.productVariant.updateMany({
          where: { id: current.id, stock: expected },
          data: { stock: nextStock },
        });
        if (updated.count === 0) {
          const fresh = await tx.productVariant.findUnique({ where: { id: current.id }, select: { stock: true } });
          conflicts.push({ size: key.size, color: key.color, expected, current: fresh?.stock ?? null });
        }
      } else if (stockMap.has(mapKey) && current.stock !== nextStock) {
        await tx.productVariant.update({ where: { id: current.id }, data: { stock: nextStock } });
      }
    } else if (expectedMap.has(mapKey)) {
      // El admin veía esta variante y ya no existe (la borró otra sesión): no se recrea con un stock que ya no es suyo.
      conflicts.push({ size: key.size, color: key.color, expected: expectedMap.get(mapKey)!, current: null });
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

  if (conflicts.length > 0) {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true } });
    throw new StockConflictError(product?.name ?? 'el producto', conflicts);
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
  tx: PrismaTransactionClient,
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
  tx: PrismaTransactionClient,
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
