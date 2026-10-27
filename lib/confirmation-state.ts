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

/* Qué dice la pantalla del email del pedido (P0-08). Antes afirmaba «te hemos enviado un email» siempre; ahora cuenta el estado REAL que devuelve
 * la API del pedido (`emailDelivery`), también como función pura. Nunca lleva el texto técnico del error: eso es del admin. */

/** Estado del email para el comprador (ver `buyerEmailView` en lib/order-email.ts). `unknown`: sin rastro (tienda, pedido anterior al seguimiento). */
export type EmailDelivery = 'sent' | 'sending' | 'retrying' | 'failed' | 'unknown';

export interface EmailNotice {
  tone: 'ok' | 'pending' | 'problem' | 'neutral';
  title: string;
  detail: string;
  /** Hay que ofrecer ya la descarga de lo comprado (el email no ha llegado todavía o no va a llegar). */
  offerDownload: boolean;
  /** El estado puede cambiar solo: la pantalla vuelve a preguntar un rato. */
  keepPolling: boolean;
}

export function emailNotice(input: { delivery?: EmailDelivery | null; kind: 'entradas' | 'tienda'; email: string }): EmailNotice {
  const { kind, email } = input;
  const entradas = kind === 'entradas';
  switch (input.delivery) {
    case 'sent':
      return {
        tone: 'ok',
        title: entradas ? 'Entradas enviadas por email' : 'Email de confirmación enviado',
        detail: entradas ? `Las hemos enviado a ${email}.` : `Te hemos enviado la confirmación a ${email}.`,
        offerDownload: false,
        keepPolling: false,
      };
    case 'sending':
      return {
        tone: 'pending',
        title: entradas ? 'Enviando tus entradas por email…' : 'Enviando el email de confirmación…',
        detail: `Te ${entradas ? 'las' : 'lo'} estamos enviando a ${email}. Llega en un par de minutos.`,
        offerDownload: false,
        keepPolling: true,
      };
    case 'retrying':
      return {
        tone: 'pending',
        title: `Te ${entradas ? 'las' : 'lo'} enviaremos en unos minutos`,
        detail: entradas
          ? 'Todavía no han salido, pero seguimos intentándolo. Mientras tanto puedes descargarlas aquí mismo.'
          : 'Todavía no ha salido, pero seguimos intentándolo. Guarda esta página: es tu justificante.',
        offerDownload: entradas,
        keepPolling: true,
      };
    case 'failed':
      return {
        tone: 'problem',
        title: 'No hemos podido enviarte el email',
        detail: entradas
          ? 'Descarga tus entradas aquí mismo, o pide que te las reenviemos.'
          : 'Guarda esta página: es tu justificante. Puedes pedir que te lo reenviemos.',
        offerDownload: entradas,
        keepPolling: false,
      };
    default:
      return {
        tone: 'neutral',
        title: entradas ? 'Tus entradas' : 'Pedido confirmado',
        detail: entradas ? 'Descárgalas aquí mismo o pide que te las enviemos por email.' : `Guarda esta página, o pide que te enviemos la confirmación a ${email}.`,
        offerDownload: entradas,
        keepPolling: false,
      };
  }
}
