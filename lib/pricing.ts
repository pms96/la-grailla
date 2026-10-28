/* Importes de venta. TODO el cálculo de un total va en CÉNTIMOS ENTEROS y se redondea una sola vez: con coma flotante, la comisión daba céntimos
 * distintos en la pasarela (`Math.round(x * 100)`) y en la BD (Decimal(10,2), redondeo de Postgres): con una comisión del 1,5 % sobre 33 €, Stripe
 * cobraba 33,49 y el pedido guardaba 33,50, y la conciliación fallaba por un céntimo (auditoría P1-07 / EN-15 / CO-06).
 *
 * Estas funciones son compartidas entre el checkout público (buy-tickets-form.tsx, para que el comprador vea el total antes de pagar) y la creación
 * real del pedido (app/api/orders/route.ts, que es quien de verdad cobra): una sola fórmula evita que ambos lados puedan divergir. */

/** Importe mínimo que Stripe admite en un pago (50 céntimos de euro). Por debajo, la pasarela rechaza la sesión y el comprador vería un error. */
export const MIN_ONLINE_PAYMENT = 0.5;

/** Euros → céntimos enteros. Los precios tienen como mucho 2 decimales (Decimal(10,2)), así que el redondeo solo absorbe el error de coma flotante. */
export const toCents = (amount: number): number => Math.round(amount * 100);

/** Céntimos enteros → euros con 2 decimales exactos (el valor que se guarda en la BD y se envía a la pasarela). */
export const fromCents = (cents: number): number => cents / 100;

/** Redondea un importe en euros a céntimos. */
export const roundMoney = (amount: number): number => fromCents(toCents(amount));

/**
 * Comisión en céntimos sobre un subtotal en céntimos. El porcentaje puede ser fraccionario (1,5 %): se pasa a milésimas de punto para multiplicar
 * en enteros, y se redondea al céntimo más cercano (la mitad hacia arriba) una sola vez.
 */
export function calculateCommissionCents(subtotalCents: number, commissionPercent: number): number {
  if (!(commissionPercent > 0) || !(subtotalCents > 0)) return 0;
  const permille = Math.round(commissionPercent * 1000);
  return Math.floor((subtotalCents * permille + 50_000) / 100_000);
}

/** Comisión en euros, ya redondeada a céntimos. */
export function calculateCommission(subtotal: number, commissionPercent: number): number {
  return fromCents(calculateCommissionCents(toCents(subtotal), commissionPercent));
}

/** Suma de importes en euros sin arrastrar error de coma flotante. */
export const sumMoney = (...amounts: number[]): number => fromCents(amounts.reduce((s, a) => s + toCents(a), 0));

/**
 * Porcentaje escrito en un formulario (acepta coma decimal), o `fallback` si está vacío o no es válido (fuera de 0–100). Un 0 escrito a propósito se
 * respeta: `Number(x) || 21` convertía un IVA exento (0 %) en 21 % sin avisar (P1-17). Pura: sirve también en componentes de cliente.
 */
export function parsePercentOr(raw: string | number | null | undefined, fallback: number): number {
  const v = String(raw ?? '').trim().replace(',', '.');
  if (v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}
