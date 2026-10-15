// Compartido entre /api/admin/gastos/resumen y /api/admin/ingresos/resumen —
// mismo cálculo de "cuánto costó de verdad" un gasto (importe sin IVA + su
// IVA), para que el total de gastos que resta el balance de Ingresos nunca
// pueda desviarse del que ya se muestra en /admin/gastos.
export function importeGastoConIva(importeSinIva: number, ivaPercent: number): number {
  return Math.round(importeSinIva * (1 + ivaPercent / 100) * 100) / 100;
}

/**
 * IVA con el que registrar como gasto un pedido cuyas líneas pueden llevar IVA distinto (un Gasto guarda un único IVA): la media
 * ponderada por la base de cada línea, de modo que el total con IVA del gasto coincide con el del pedido. Con un solo tipo de IVA
 * es ese tipo exacto. Las líneas con base 0 o negativa (abonos) no cuentan; sin base devuelve el 21 % habitual.
 */
export function ivaEfectivo(lineas: { base: number; ivaPercent: number }[]): number {
  const positivas = lineas.filter((l) => l.base > 0);
  const base = positivas.reduce((s, l) => s + l.base, 0);
  if (base <= 0) return 21;
  const iva = positivas.reduce((s, l) => s + l.base * (l.ivaPercent / 100), 0);
  return Math.round((iva / base) * 100 * 100) / 100;
}
