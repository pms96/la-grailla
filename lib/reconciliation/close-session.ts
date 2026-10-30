import {
  accountScopeForOrder,
  effectiveStatus,
  getPaymentProviderByName,
  type CancelPaymentResult,
  type PaymentProvider,
  type PaymentResult,
} from '@/lib/payment-adapter';
import { logPaymentEvent } from './shared';

/* Cerrar la sesión de pago viva de un pedido que se va a liberar o anular (P0-05): sin esto, el comprador puede seguir pagando un pedido
 * que ya no existe. Siempre «expirar → volver a verificar»: si la sesión resulta estar ya pagada, el cierre falla y la verificación lo dice. */

/** Cierra la sesión (si la pasarela puede) y vuelve a verificar. Nunca lanza. */
export async function expireThenVerify(
  provider: PaymentProvider,
  paymentId: string
): Promise<{ cancel: CancelPaymentResult | null; result: PaymentResult }> {
  let cancel: CancelPaymentResult | null = null;
  if (provider.capabilities.cancelCheckout && provider.cancelPayment) {
    try {
      cancel = await provider.cancelPayment(paymentId);
    } catch (error) {
      cancel = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const result = await provider.verifyPayment(paymentId);
  return { cancel, result };
}

/**
 * Mejor esfuerzo antes de que alguien anule a mano un pedido PENDING: cierra su sesión de pago. Devuelve el resultado de la verificación SI
 * resulta que el pedido ya estaba pagado (quien llama no debe anularlo: debe completarlo). Cualquier fallo se registra y no lanza: anular
 * no puede quedarse bloqueado por una pasarela caída (si luego llegase el pago, el flujo de pago tardío lo resuelve).
 */
export async function closeSessionBeforeCancel(
  kind: 'entradas' | 'tienda',
  order: { id: string; paymentProvider: string | null; paymentId: string | null; createdAt?: Date }
): Promise<{ paid?: PaymentResult }> {
  if (!order.paymentProvider || order.paymentProvider === 'mock' || !order.paymentId) return {};
  try {
    const provider = await getPaymentProviderByName(order.paymentProvider, await accountScopeForOrder(kind, order));
    if (!provider.capabilities.cancelCheckout || !provider.cancelPayment) return {};
    const { cancel, result } = await expireThenVerify(provider, order.paymentId);
    const status = effectiveStatus(result);
    if (status === 'PAID') return { paid: result };
    if (!cancel?.ok && status !== 'EXPIRED') {
      logPaymentEvent('[reconcile]', { kind, orderId: order.id, provider: order.paymentProvider, status, reason: `session_not_closed_on_cancel: ${cancel?.error ?? 'sin detalle'}` }, 'warn');
    }
  } catch (error) {
    logPaymentEvent('[reconcile]', { kind, orderId: order.id, provider: order.paymentProvider, reason: `close_session_failed: ${error instanceof Error ? error.message : String(error)}` }, 'warn');
  }
  return {};
}

/** URL de la sesión de pago viva de un pedido PENDING, para devolverla en un reintento con la misma clave de idempotencia (TI-12 / EN-07). `null` si no hay. */
export async function resumeCheckoutUrl(
  kind: 'entradas' | 'tienda',
  order: { status: string; paymentProvider: string | null; paymentId: string | null; createdAt?: Date }
): Promise<string | null> {
  if (order.status !== 'PENDING' || !order.paymentId || !order.paymentProvider || order.paymentProvider === 'mock') return null;
  try {
    const provider = await getPaymentProviderByName(order.paymentProvider, await accountScopeForOrder(kind, order));
    return (await provider.resumeCheckout?.(order.paymentId)) ?? null;
  } catch {
    return null;
  }
}
