import type { Prisma } from '@prisma/client';

export type PrecioInput = {
  proveedorId: string;
  precioSinIva: number;
  descuentoPercent?: number;
  formatoVenta: string;
  unidadMinPedido: number;
  notas?: string | null;
};

/**
 * Sincroniza PrecioArticulo con la lista de precios enviada desde el formulario
 * de Artículo. Un proveedor ausente de la lista se elimina; el resto se hace
 * upsert por la clave única (articuloId, proveedorId).
 */
export async function syncPreciosArticulo(
  tx: Prisma.TransactionClient,
  articuloId: string,
  precios: PrecioInput[] | undefined
): Promise<void> {
  if (precios === undefined) return;

  const existentes = await tx.precioArticulo.findMany({ where: { articuloId } });
  const proveedorIds = new Set(precios.map((p) => p.proveedorId));

  for (const existente of existentes) {
    if (!proveedorIds.has(existente.proveedorId)) {
      await tx.precioArticulo.delete({ where: { id: existente.id } });
    }
  }

  for (const precio of precios) {
    await tx.precioArticulo.upsert({
      where: { articuloId_proveedorId: { articuloId, proveedorId: precio.proveedorId } },
      create: {
        articuloId,
        proveedorId: precio.proveedorId,
        precioSinIva: precio.precioSinIva,
        descuentoPercent: precio.descuentoPercent ?? 0,
        formatoVenta: precio.formatoVenta,
        unidadMinPedido: precio.unidadMinPedido,
        notas: precio.notas || null,
      },
      update: {
        precioSinIva: precio.precioSinIva,
        descuentoPercent: precio.descuentoPercent ?? 0,
        formatoVenta: precio.formatoVenta,
        unidadMinPedido: precio.unidadMinPedido,
        notas: precio.notas || null,
      },
    });
  }
}
