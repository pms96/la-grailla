/* Qué debe decir la pantalla de confirmación del comprador (entradas y tienda). Función pura: la misma decisión para las dos pantallas y probada sin
 * renderizar nada. La API del pedido devuelve `paymentCheck` (el resultado de comprobar un pedido anulado contra la pasarela) y el cliente lo combina
 * con el estado del pedido y con si ya agotó el sondeo. */

/** Resultado de comprobar contra la pasarela un pedido CANCELLED con pago asociado (ver lib/reconciliation/payment-check.ts). */
export type PaymentCheck = 'none' | 'checking' | 'not_paid' | 'paid' | 'refunded';

export type ConfirmationView =
  | 'confirmed' // pagado: se muestra la compra
  | 'pending' // esperando la confirmación de la pasarela
  | 'checking' // anulado pero con un pago que se está comprobando
  | 'checking_gave_up' // se agotó el sondeo sin resolverse: se pide al comprador que escriba con su código
  | 'not_charged' // anulado y la pasarela confirma que NO se cobró (o nunca hubo pago)
  | 'refunded'; // el cobro consta devuelto

export function confirmationView(input: {
  status: string;
  paymentId?: string | null;
  paymentCheck?: PaymentCheck | null;
  /** El cliente ya hizo todos los sondeos que iba a hacer. */
  pollsExhausted: boolean;
}): ConfirmationView {
  const { status, paymentId, paymentCheck, pollsExhausted } = input;
  if (status === 'PENDING') return 'pending';
  if (status === 'REFUNDED') return 'refunded';
  if (status === 'CANCELLED') {
    if (paymentCheck === 'refunded') return 'refunded';
    // «No se ha realizado ningún cargo» SOLO si la pasarela lo ha confirmado o si nunca hubo pago que comprobar.
    if (paymentCheck === 'not_paid' || !paymentId) return 'not_charged';
    return pollsExhausted ? 'checking_gave_up' : 'checking';
  }
  return 'confirmed'; // COMPLETED / PAID / PROCESSING / SHIPPED / DELIVERED
}

/** ¿Merece la pena seguir sondeando? Solo mientras el resultado pueda cambiar. */
export function shouldKeepPolling(view: ConfirmationView): boolean {
  return view === 'pending' || view === 'checking';
}
