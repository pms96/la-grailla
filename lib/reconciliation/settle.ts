import { accountScopeForOrder, effectiveStatus, getPaymentProviderByName, type PaymentProvider, type PaymentResult } from '@/lib/payment-adapter';
import { expireThenVerify } from './close-session';
import { STALE_ORDER_SAFETY_NET_MS, isPastReleaseDeadline } from '@/lib/checkout-hold';
import { completeOrder, releaseExpiredOrder } from './entradas';
import { completeShopOrder, releaseExpiredShopOrder } from './tienda';
import { alertOperator, logPaymentEvent } from './shared';
import { escapeHtml as esc } from '@/lib/html-escape';

/* Qué hacer con un pedido PENDING cuyo pago no ha llegado (P0-06 + P0-05 + P0-04). Lo usan el cron de reconciliación y la ruta de abandono
 * del comprador, para que la regla sea UNA y esté probada una vez.
 *
 * Regla de oro: solo se libera aforo/stock con la PASARELA confirmando que ese pago ya no puede llegar. Un fallo al consultarla
 * (UNKNOWN) NUNCA es «no pagado», y un cobro en curso (PROCESSING) tampoco: eso cancelaría ventas que pueden estar cobradas.
 *
 *   verificación         antes del plazo            tras el plazo (o el comprador abandona)
 *   PAID                 completar                   completar
 *   EXPIRED              liberar                     liberar
 *   PENDING / FAILED     seguir esperando            cerrar la sesión → verificar de nuevo → ver abajo
 *   PROCESSING           NO liberar, seguir          NO liberar, seguir
 *   UNKNOWN / error      NO liberar, error           NO liberar, error
 * Tras cerrar la sesión y verificar de nuevo: PAID → completar (el cierre falla si ya estaba pagada); EXPIRED → liberar; PENDING/FAILED →
 * liberar solo si la pasarela confirmó el cierre; PROCESSING, UNKNOWN o cierre no confirmado → no liberar. */

export type SettleKind = 'entradas' | 'tienda';

export type SettleOutcome =
  | 'completed' // el pago estaba hecho: pedido completado (o reactivado)
  | 'released' // liberado: aforo/stock devuelto
  | 'pending' // sigue sin pagar y aún dentro de plazo (o la sesión no se ha podido cerrar): se mira en la siguiente pasada
  | 'processing' // sesión completa con el pago en curso (asíncrono): el dinero está en camino
  | 'unknown' // la pasarela no se ha podido consultar: nada se toca y cuenta como error
  | 'attention'; // el pago consta pero no se ha podido completar solo (importe que no cuadra, estado inesperado): ya se ha avisado

export interface SettleResult {
  outcome: SettleOutcome;
  /** Estado de cobro que motivó la decisión. */
  status?: string;
  /** Motivo legible del error / de la atención (sin datos personales). */
  reason?: string;
  /** El pedido lleva más de 24 h con el pago sin poder resolverse (UNKNOWN o PROCESSING): ya se ha avisado al operador. */
  stuck?: boolean;
}

/** Desde cuándo un pedido con la pasarela «desconocida» o «en curso» deja de ser un hipo y pasa a exigir una revisión manual. */
export const STUCK_AFTER_MS = 24 * 60 * 60_000;

export interface SettleOrder {
  id: string;
  paymentProvider: string | null;
  paymentId: string | null;
  createdAt: Date;
}

const releaseOrder = (kind: SettleKind, id: string) => (kind === 'entradas' ? releaseExpiredOrder(id) : releaseExpiredShopOrder(id));

async function completePaid(kind: SettleKind, id: string, result: PaymentResult, baseUrl?: string, emailInline?: boolean): Promise<SettleResult> {
  const outcome = kind === 'entradas' ? await completeOrder(id, baseUrl, result, { emailInline }) : await completeShopOrder(id, result, { emailInline, baseUrl });
  if (outcome === 'completed' || outcome === 'already_completed' || outcome === 'revived') return { outcome: 'completed', status: 'PAID' };
  return { outcome: 'attention', status: 'PAID', reason: `paid_but_${outcome}` };
}

export async function settleUnpaidOrder(params: {
  kind: SettleKind;
  order: SettleOrder;
  abandoned?: boolean;
  baseUrl?: string;
  now?: number;
  /** El email del pedido que se complete se envía en el acto (el cron, que acota su concurrencia y su tiempo) en vez de tras la respuesta. */
  emailInline?: boolean;
}): Promise<SettleResult> {
  const result = await decideUnpaidOrder(params);
  const { kind, order } = params;
  const now = params.now ?? Date.now();
  // Un pedido con pago en la pasarela que sigue sin poder resolverse pasadas 24 h (clave caducada o de otra cuenta, checkout borrado, cobro
  // asíncrono que no termina…) ya no se libera NUNCA por tiempo (P0-06) y se queda reteniendo aforo/stock: alguien tiene que mirarlo. Un
  // aviso por pedido y día (el log estructurado sale siempre).
  if ((result.outcome === 'unknown' || result.outcome === 'processing') && now - order.createdAt.getTime() >= STUCK_AFTER_MS) {
    const reason = result.outcome === 'unknown' ? 'stuck_unknown' : 'stuck_processing';
    await alertOperator({
      kind,
      tag: '[reconcile]',
      orderId: order.id,
      reason,
      details: { provider: order.paymentProvider ?? null, status: result.status ?? null, detail: result.reason ?? null, ageHours: Math.floor((now - order.createdAt.getTime()) / 3_600_000) },
      dedupeKey: `stuck:${order.id}`,
      subject: `⚠️ Pedido con el pago sin resolver desde hace más de 24 h (${order.id.slice(0, 8)})`,
      html:
        `<p>El pedido de ${kind} <strong>${esc(order.id)}</strong> lleva más de 24 h pendiente y la pasarela (${esc(order.paymentProvider ?? '-')}) ` +
        (result.outcome === 'unknown'
          ? `no se puede consultar: <em>${esc(result.reason ?? 'sin detalle')}</em>.`
          : 'dice que el cobro sigue en curso (pago asíncrono) sin llegar a resolverse.') +
        '</p><p>Por seguridad el sistema NO libera ni cancela un pedido cuyo pago no puede confirmar como no pagado: sigue reteniendo su aforo/stock. ' +
        'Comprueba el estado del cobro en la pasarela (revisa que la clave y la cuenta de este módulo son las correctas). Si no hay cobro, anula el pedido a mano desde el admin; si lo hay, márcalo como pagado.</p>',
    });
    return { ...result, stuck: true };
  }
  return result;
}

async function decideUnpaidOrder(params: {
  kind: SettleKind;
  order: SettleOrder;
  /** El propio comprador ha abandonado el pago (volvió por `cancelUrl`): no hace falta esperar al plazo. */
  abandoned?: boolean;
  baseUrl?: string;
  now?: number;
  emailInline?: boolean;
}): Promise<SettleResult> {
  const { kind, order } = params;
  const now = params.now ?? Date.now();
  // El cobro consta REFUNDED en la pasarela sobre un pedido que seguía PENDING (alguien lo reembolsó a mano): NO se completa (se entregaría sin cobrar)
  // ni se libera sin que alguien lo mire; se avisa al operador (una vez al día por pedido).
  const refundedWhilePending = async (status: string): Promise<SettleResult> => {
    await alertOperator({
      kind,
      tag: '[reconcile]',
      orderId: order.id,
      reason: 'payment_refunded_on_pending_order',
      details: { provider: order.paymentProvider ?? null, status },
      dedupeKey: `refunded-pending:${order.id}`,
      subject: `⚠️ Pedido pendiente cuyo cobro consta reembolsado (${order.id.slice(0, 8)})`,
      html:
        `<p>El pedido de ${kind} <strong>${esc(order.id)}</strong> sigue pendiente, pero la pasarela dice que su cobro está reembolsado (total o parcialmente).</p>` +
        '<p>No se ha completado ni entregado nada. Si el reembolso fue intencionado, anula el pedido desde el admin.</p>',
    });
    return { outcome: 'attention', status, reason: 'payment_refunded_on_pending_order' };
  };
  const logUnknown = (reason: string, status?: string) =>
    logPaymentEvent('[reconcile]', { kind, orderId: order.id, provider: order.paymentProvider ?? null, status: status ?? null, reason });

  const hasGatewayPayment = Boolean(order.paymentProvider && order.paymentProvider !== 'mock' && order.paymentId);
  if (!hasGatewayPayment) {
    // Nunca llegó a la pasarela: no hay a quién preguntar. Red de seguridad por antigüedad (24 h) y solo eso.
    if (!params.abandoned && now - order.createdAt.getTime() >= STALE_ORDER_SAFETY_NET_MS) {
      return (await releaseOrder(kind, order.id)) ? { outcome: 'released', reason: 'no_gateway_payment_stale' } : { outcome: 'pending' };
    }
    return { outcome: 'pending' };
  }

  let provider: PaymentProvider;
  try {
    provider = await getPaymentProviderByName(order.paymentProvider!, await accountScopeForOrder(kind, order));
  } catch (error) {
    const reason = `provider_unavailable: ${error instanceof Error ? error.message : String(error)}`;
    logUnknown(reason);
    return { outcome: 'unknown', reason };
  }

  const paymentId = order.paymentId!;
  const first = await provider.verifyPayment(paymentId);
  const status = effectiveStatus(first);
  if (status === 'UNKNOWN') {
    const reason = `verification_failed: ${first.error ?? 'sin detalle'}`;
    logUnknown(reason, status);
    return { outcome: 'unknown', status, reason };
  }
  if (status === 'PAID') return completePaid(kind, order.id, first, params.baseUrl, params.emailInline);
  if (status === 'PROCESSING') return { outcome: 'processing', status };
  if (status === 'REFUNDED') return refundedWhilePending(status);
  if (status === 'EXPIRED') {
    return (await releaseOrder(kind, order.id)) ? { outcome: 'released', status } : { outcome: 'pending', status };
  }

  // PENDING o FAILED: la sesión aún podría estar abierta. Solo se actúa pasado el plazo o si el comprador abandonó.
  if (!params.abandoned && !isPastReleaseDeadline(order.createdAt, now)) return { outcome: 'pending', status };

  if (!provider.capabilities.cancelCheckout || !provider.cancelPayment) {
    // Sin forma de cerrar la sesión no se puede garantizar que no se pague después: solo la red de seguridad de 24 h libera.
    if (!params.abandoned && now - order.createdAt.getTime() >= STALE_ORDER_SAFETY_NET_MS) {
      return (await releaseOrder(kind, order.id)) ? { outcome: 'released', status, reason: 'no_cancel_capability_stale' } : { outcome: 'pending', status };
    }
    return { outcome: 'pending', status };
  }

  const { cancel, result: second } = await expireThenVerify(provider, paymentId);
  const status2 = effectiveStatus(second);
  if (status2 === 'PAID') return completePaid(kind, order.id, second, params.baseUrl, params.emailInline);
  if (status2 === 'UNKNOWN') {
    const reason = `verification_failed_after_expire: ${second.error ?? 'sin detalle'}`;
    logUnknown(reason, status2);
    return { outcome: 'unknown', status: status2, reason };
  }
  if (status2 === 'PROCESSING') return { outcome: 'processing', status: status2 };
  if (status2 === 'REFUNDED') return refundedWhilePending(status2);
  if (status2 === 'EXPIRED' || cancel?.ok) {
    return (await releaseOrder(kind, order.id)) ? { outcome: 'released', status: status2 } : { outcome: 'pending', status: status2 };
  }
  // PENDING/FAILED y la pasarela no ha confirmado el cierre: la sesión puede seguir viva. No se libera; se reintenta en la siguiente pasada.
  logPaymentEvent('[reconcile]', { kind, orderId: order.id, provider: order.paymentProvider, status: status2, reason: `session_not_closed: ${cancel?.error ?? 'sin detalle'}` }, 'warn');
  return { outcome: 'pending', status: status2, reason: 'session_not_closed' };
}
