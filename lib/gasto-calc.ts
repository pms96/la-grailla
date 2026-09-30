// Compartido entre /api/admin/gastos/resumen y /api/admin/ingresos/resumen —
// mismo cálculo de "cuánto costó de verdad" un gasto (importe sin IVA + su
// IVA), para que el total de gastos que resta el balance de Ingresos nunca
// pueda desviarse del que ya se muestra en /admin/gastos.
export function importeGastoConIva(importeSinIva: number, ivaPercent: number): number {
  return Math.round(importeSinIva * (1 + ivaPercent / 100) * 100) / 100;
}
