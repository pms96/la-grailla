// Fórmula compartida entre el checkout público (buy-tickets-form.tsx, para
// que el comprador vea el total antes de pagar) y la creación real del
// pedido (app/api/orders/route.ts, que es quien de verdad cobra) — una sola
// función evita que ambos lados puedan divergir y mostrar un total distinto
// al que se cobra en la pasarela.
export function calculateCommission(subtotal: number, commissionPercent: number): number {
  return subtotal * (commissionPercent / 100);
}
