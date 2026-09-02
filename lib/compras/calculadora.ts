export function precioConIva(precioSinIva: number, ivaPercent: number): number {
  return Math.round(precioSinIva * (1 + ivaPercent / 100) * 100) / 100;
}

/** Precio sin IVA tras aplicar el descuento que nos hace el proveedor en ese artículo. */
export function precioTrasDescuento(precioSinIva: number, descuentoPercent: number): number {
  return Math.round(precioSinIva * (1 - descuentoPercent / 100) * 100) / 100;
}

/** Precio final por unidad (con descuento e IVA aplicados) — el que se paga de verdad. */
export function precioFinalUnidad(precioSinIva: number, descuentoPercent: number, ivaPercent: number): number {
  return precioConIva(precioTrasDescuento(precioSinIva, descuentoPercent), ivaPercent);
}

export type PrecioComparado = {
  proveedorId: string;
  proveedorNombre: string;
  precioSinIva: number;
  precioConIva: number;
};

export function proveedorRecomendado(precios: PrecioComparado[]): PrecioComparado | null {
  if (precios.length === 0) return null;
  return precios.reduce((min, p) => (p.precioConIva < min.precioConIva ? p : min));
}

export function ahorroFrenteAlMasCaro(precios: PrecioComparado[]): number {
  if (precios.length < 2) return 0;
  const valores = precios.map((p) => p.precioConIva);
  return Math.round((Math.max(...valores) - Math.min(...valores)) * 100) / 100;
}

export function porcentajeAhorro(precioElegido: number, precioMasCaro: number): number {
  if (precioMasCaro <= 0) return 0;
  return Math.round(((precioMasCaro - precioElegido) / precioMasCaro) * 1000) / 10;
}
