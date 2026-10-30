import { accountScopeForOrder, getPaymentProviderByName, effectiveStatus, type PaymentProvider } from '@/lib/payment-adapter';
import { sendMail } from '@/lib/mailer';
import { escapeHtml as esc } from '@/lib/html-escape';
import { getBrand } from '@/lib/brand/brand';
import { brandLogoHtml } from '@/lib/brand/email';
import { getFallbackBaseUrl } from '@/lib/url';
import { prisma } from '@/lib/prisma';
import { alertOperator, logPaymentEvent, paymentMatchesOrder, type CompleteOutcome } from './shared';

/** Marca «para este pedido se ha decidido devolver el dinero»: una vez puesta, ya no se intenta reactivar (así un reintento nunca cobra Y entrega). */
export const lateRefundMarker = (orderId: string) => `late-refund:${orderId}`;

/* Piezas comunes del «pago tardío» (P0-05): un pago confirmado sobre un pedido que ya se había liberado o anulado. Lo que cambia entre
 * entradas y tienda (reservar aforo o stock, restituir tickets o líneas) vive en ./entradas.ts y ./tienda.ts; aquí solo está lo que no
 * depende del módulo: comprobar de verdad el pago con la pasarela, devolver el dinero y avisar al comprador. */

type Kind = 'entradas' | 'tienda';

export type LateGateway =
  /** La pasarela confirma el cobro y el importe cuadra con el pedido: se puede reactivar o reembolsar. */
  | { state: 'paid'; provider: PaymentProvider }
  /** La pasarela NO lo da por pagado (un evento atrasado, un cobro anulado…): no se hace nada. */
  | { state: 'not_paid'; status: string }
  /** El importe cobrado no cuadra con el pedido: no se reactiva ni se reembolsa (ya se avisó). */
  | { state: 'mismatch' }
  /**
   * La pasarela dice que el cobro está REEMBOLSADO (total o parcialmente). `ours` = lo reembolsó este sistema (hay marca `late-refund`): solo falta
   * terminar de marcar el pedido. Si no, lo reembolsó alguien a mano: NO se reanima (se entregaría sin cobrar) y se avisa al operador.
   */
  | { state: 'refunded'; ours: boolean; provider: PaymentProvider }
  /** No se ha podido comprobar (sin pago asociado, clave inválida, pasarela caída): NO se actúa; ante la duda ni se reactiva ni se devuelve dinero. */
  | { state: 'unverifiable'; reason: string };

/**
 * Antes de tocar nada de un pedido anulado, se vuelve a preguntar a la pasarela: el webhook no trae el importe y un evento atrasado o
 * duplicado no es prueba de que el dinero esté cobrado hoy. Solo con «pagado» y el importe contrastado se reactiva o se reembolsa.
 */
export async function confirmLatePayment(
  kind: Kind,
  order: { id: string; paymentProvider: string | null; paymentId: string | null; createdAt?: Date }
): Promise<LateGateway> {
  if (!order.paymentProvider || order.paymentProvider === 'mock' || !order.paymentId) {
    return { state: 'unverifiable', reason: 'order_has_no_gateway_payment' };
  }
  let provider: PaymentProvider;
  try {
    provider = await getPaymentProviderByName(order.paymentProvider, await accountScopeForOrder(kind, order));
  } catch (error) {
    return { state: 'unverifiable', reason: `provider_unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = await provider.verifyPayment(order.paymentId);
  const status = effectiveStatus(result);
  if (status === 'UNKNOWN') return { state: 'unverifiable', reason: `verification_failed: ${result.error ?? 'sin detalle'}` };
  if (status === 'REFUNDED') {
    const ours = Boolean(await prisma.processedWebhookEvent.findUnique({ where: { id: lateRefundMarker(order.id) } }));
    return { state: 'refunded', ours, provider };
  }
  if (status !== 'PAID') return { state: 'not_paid', status };
  if (!(await paymentMatchesOrder(kind, order.id, result))) return { state: 'mismatch' };
  return { state: 'paid', provider };
}

/** Reembolso total e idempotente (`late_<pedido>`): repetirlo, aunque sea desde el webhook y el cron a la vez, no devuelve el dinero dos veces. */
export async function refundLatePayment(
  provider: PaymentProvider,
  order: { id: string; paymentId: string | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!order.paymentId) return { ok: false, error: 'el pedido no tiene pago asociado' };
  if (!provider.capabilities.refunds) return { ok: false, error: `${provider.name} no admite reembolsos por API` };
  try {
    const refund = await provider.refund(order.paymentId, undefined, `late_${order.id}`);
    return refund.success ? { ok: true } : { ok: false, error: refund.error ?? 'el reembolso en la pasarela ha fallado' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Email al comprador: su pago llegó tras caducar la reserva y se le ha devuelto. Con la marca del cliente; un fallo de envío solo se registra. */
export async function sendLateRefundEmail(
  kind: Kind,
  order: { id: string; buyerName: string; buyerEmail: string; totalAmount: number | string | { toString(): string } }
): Promise<void> {
  try {
    const brand = await getBrand();
    const what = kind === 'entradas' ? 'tus entradas' : 'tu pedido';
    const why = kind === 'entradas' ? 'ya no quedaban entradas disponibles' : 'ya no quedaba stock de alguno de los productos';
    const result = await sendMail({
      to: order.buyerEmail,
      subject: `Te hemos devuelto tu pago - ${brand.name}`,
      html:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">' +
        brandLogoHtml(brand, getFallbackBaseUrl(), 32, 'margin:0 0 20px;') +
        `<p>Hola ${esc(order.buyerName)},</p>` +
        `<p>Tu pago de <strong>${Number(order.totalAmount).toFixed(2)} EUR</strong> nos llegó cuando la reserva de ${what} ya había caducado ` +
        `y ${why}. No hemos podido completar la compra, así que <strong>te hemos devuelto el importe íntegro</strong> a tu método de pago original.</p>` +
        '<p>La devolución puede tardar unos días en aparecer, según tu banco.</p>' +
        `<p style="color:#666;">Referencia: ${esc(order.id.slice(0, 8).toUpperCase())}. Sentimos las molestias.</p>` +
        '</div>',
    });
    if (!result.success) logPaymentEvent('[late-payment]', { orderId: order.id, reason: 'buyer_email_failed', error: result.error });
  } catch (error) {
    logPaymentEvent('[late-payment]', { orderId: order.id, reason: 'buyer_email_failed', error: error instanceof Error ? error.message : String(error) });
  }
}

type LateOrder = { id: string; buyerName: string; buyerEmail: string; totalAmount: number | string | { toString(): string }; paymentId: string | null };

/**
 * Tramo común del pago tardío SIN plazas/stock: devolver el dinero y dejar el pedido REFUNDED. Primero el dinero (idempotente por `late_<pedido>`),
 * después el estado; si el proceso muere en medio, el siguiente reintento termina sin duplicar nada.
 *  - `claim()`: la transición condicionada CANCELLED → REFUNDED (true = la ha hecho ESTA llamada, y solo ella avisa al comprador).
 *  - `readStatus()`: el estado actual del pedido.
 * Ante un error de reembolso NO se alerta sin comprobar antes: con entregas simultáneas el reembolso de la pasarela puede fallar por
 * «idempotency key en uso» o «ya reembolsado» aunque otra entrega lo haya hecho bien. Se relee el pedido y se vuelve a preguntar a la pasarela;
 * solo si de verdad no está devuelto se avisa («reembolso FALLIDO»).
 */
export async function finishLateRefund(params: Parameters<typeof finishLateRefundLocked>[0]): Promise<CompleteOutcome> {
  // Un cerrojo por pedido (mutex en la BD, `pg_advisory_xact_lock`) hace que dos entregas simultáneas del mismo pago tardío no se solapen: la
  // segunda espera a que la primera termine y entonces encuentra el pedido REFUNDED. Sin él, la pasarela rechaza el segundo reembolso
  // (clave de idempotencia en uso, o ya reembolsado) y salta una alerta falsa de «reembolso FALLIDO». Se mantiene la transacción abierta
  // durante la llamada a la pasarela (como mucho unos segundos: SumUp lleva timeout de 15 s) en un camino raro: solo pagos tardíos sin hueco.
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'late-refund-lock:' + params.order.id}))`;
      const status = await params.readStatus();
      if (status === 'REFUNDED') return 'refunded_late' as CompleteOutcome; // otra entrega ya lo ha terminado
      if (status !== 'CANCELLED') return 'inactive' as CompleteOutcome; // cambió de estado por otro camino: no decide esta llamada
      return finishLateRefundLocked(params);
    },
    { maxWait: 60_000, timeout: 60_000 }
  );
}

async function finishLateRefundLocked(params: {
  kind: 'entradas' | 'tienda';
  order: LateOrder;
  provider: PaymentProvider;
  /** El reembolso ya consta hecho en la pasarela (lo hizo este sistema antes de un corte): solo falta marcar el pedido. */
  alreadyRefunded?: boolean;
  claim: () => Promise<boolean>;
  readStatus: () => Promise<string | undefined>;
}): Promise<CompleteOutcome> {
  const { kind, order, provider } = params;
  const stock = kind === 'entradas' ? 'plazas' : 'stock';
  let refunded = Boolean(params.alreadyRefunded);

  if (!refunded) {
    const refund = await refundLatePayment(provider, order);
    if (refund.ok) {
      refunded = true;
    } else {
      const status = await params.readStatus();
      if (status === 'REFUNDED') return 'refunded_late'; // otra entrega ya lo ha terminado
      if (status !== 'CANCELLED') return 'inactive'; // cambió de estado por otro camino: no es esta llamada quien decide
      const recheck = await provider.verifyPayment(order.paymentId ?? '');
      if (effectiveStatus(recheck) === 'REFUNDED') {
        refunded = true; // el reembolso consta en la pasarela (otra entrega, o un reintento que sí llegó)
      } else {
        await alertOperator({
          kind,
          tag: '[late-payment]',
          orderId: order.id,
          reason: 'refund_failed',
          details: { detail: refund.error },
          dedupeKey: `late-refund-failed:${order.id}`,
          subject: `🚨 Pago tardío sin ${stock} y reembolso FALLIDO (${order.id.slice(0, 8)})`,
          html:
            `<p>El pedido${kind === 'tienda' ? ' de tienda' : ''} <strong>${esc(order.id)}</strong> estaba anulado y su pago ha llegado después; ya no hay ${stock}, así que se intentó devolver el dinero, pero la pasarela ha respondido: <em>${esc(refund.error)}</em>.</p>` +
            `<p><strong>El comprador ha pagado ${Number(order.totalAmount).toFixed(2)} EUR y no ${kind === 'entradas' ? 'tiene entrada' : 'recibirá su pedido'}.</strong> Reembólsalo desde la pasarela y contacta con él (${esc(order.buyerEmail)}). El sistema volverá a intentarlo cuando llegue otro aviso del pago.</p>`,
        });
        return 'late_unresolved';
      }
    }
  }

  if (!(await params.claim())) return 'refunded_late'; // otra entrega ya lo marcó y avisó
  await sendLateRefundEmail(kind, order);
  await alertOperator({
    kind,
    tag: '[late-payment]',
    orderId: order.id,
    reason: 'refunded_no_capacity',
    dedupeKey: `late-refunded:${order.id}`,
    subject: `Pago tardío reembolsado automáticamente (${order.id.slice(0, 8)})`,
    html: `<p>El pedido${kind === 'tienda' ? ' de tienda' : ''} <strong>${esc(order.id)}</strong> estaba anulado y su pago llegó después; ya no quedaban ${stock}. Se han devuelto ${Number(order.totalAmount).toFixed(2)} EUR al comprador y se le ha avisado por correo. No hace falta hacer nada.</p>`,
  });
  return 'refunded_late';
}

/** El cobro de un pedido anulado consta REFUNDED en la pasarela y NO por nosotros (alguien lo reembolsó a mano): no se reanima ni se completa; se avisa. */
export async function alertManuallyRefunded(kind: 'entradas' | 'tienda', orderId: string, status: string): Promise<void> {
  await alertOperator({
    kind,
    tag: '[late-payment]',
    orderId,
    reason: 'refunded_in_gateway',
    details: { status },
    dedupeKey: `late-refunded-gateway:${orderId}`,
    subject: `⚠️ Pago reembolsado en la pasarela sobre un pedido anulado (${orderId.slice(0, 8)})`,
    html:
      `<p>Ha llegado la confirmación de un pago para el pedido${kind === 'tienda' ? ' de tienda' : ''} <strong>${esc(orderId)}</strong>, que ya estaba anulado, pero la pasarela dice que ese cobro YA está reembolsado (total o parcialmente).</p>` +
      '<p>Por eso no se ha reactivado ni entregado nada (se entregaría sin cobrar). El pedido sigue anulado; no hace falta hacer nada más salvo contactar con el comprador si procede.</p>',
  });
}
