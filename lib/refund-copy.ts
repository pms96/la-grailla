/* Texto de las pantallas de confirmación de un pedido REFUNDED (H-098). Para CUALQUIER pedido reembolsado decían «Este pedido no se ha podido completar y te hemos devuelto el
 * importe»: falso para uno que se completó y se reembolsó después (por el organizador, por una disputa o por un reembolso hecho en el panel de la pasarela). Una sola frase
 * que es verdad en todos los casos: dice qué ha pasado con el dinero, cuándo se verá y a quién escribir, sin afirmar por qué. */

export const REFUNDED_TITLE = 'Te hemos devuelto el pago';

export function refundedMessage(amount: number): string {
  const euros = `${(Number.isFinite(amount) ? amount : 0).toFixed(2)}€`;
  return `Hemos devuelto el importe de este pedido (${euros}) a tu método de pago original. Puede tardar unos días en aparecer en tu cuenta, según tu banco. Si no esperabas esta devolución, escríbenos con tu referencia.`;
}
