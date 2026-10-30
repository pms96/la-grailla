import { prisma } from '@/lib/prisma';
import { accountScopeForOrder, effectiveStatus, getPaymentProviderByName } from '@/lib/payment-adapter';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import type { PaymentCheck } from '@/lib/confirmation-state';
import type { CompleteOutcome, PaidInfo } from './shared';

/* Comprobación de un pedido ANULADO (CANCELLED) con pago asociado cuando el comprador abre su confirmación: pudo pagar DESPUÉS de liberarse
 * (SumUp no tiene webhook; el de Stripe puede retrasarse). Antes cada petición consultaba la pasarela, durante 7 días, y la pantalla decía
 * «estamos comprobando» aunque la pasarela ya hubiera confirmado que no se pagó. Ahora:
 *  - el resultado se devuelve explícito (`paymentCheck`) para que la pantalla diga lo correcto;
 *  - se cachea unos segundos, compartido entre instancias (en `RateLimitBucket`: la clave lleva el resultado), así los sondeos no golpean la pasarela;
 *  - y hay un límite por pedido e IP: pasado el límite no se consulta, se responde con lo último conocido (nunca un 429: la pantalla sigue funcionando). */

/** Cuánto vale una comprobación ya hecha. */
export const PAYMENT_CHECK_TTL_MS = 10_000;
/** Consultas a la pasarela por pedido e IP y minuto, además de la caché. */
const CHECKS_PER_MINUTE = 12;
/** Ventana tras la creación del pedido en la que merece la pena comprobar un pago tardío. */
export const LATE_PAYMENT_WINDOW_MS = 7 * 24 * 60 * 60_000;

const cachePrefix = (orderId: string) => `paycheck:${orderId}:`;

async function readCache(orderId: string): Promise<Exclude<PaymentCheck, 'paid' | 'none'> | null> {
  const row = await prisma.rateLimitBucket.findFirst({ where: { key: { startsWith: cachePrefix(orderId) }, resetAt: { gt: new Date() } } });
  const value = row?.key.slice(cachePrefix(orderId).length);
  return value === 'checking' || value === 'not_paid' || value === 'refunded' ? value : null;
}

async function writeCache(orderId: string, value: 'checking' | 'not_paid' | 'refunded'): Promise<void> {
  try {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: cachePrefix(orderId) } } });
    await prisma.rateLimitBucket.createMany({ data: [{ key: `${cachePrefix(orderId)}${value}`, count: 1, resetAt: new Date(Date.now() + PAYMENT_CHECK_TTL_MS) }], skipDuplicates: true });
  } catch {
    // La caché es una mejora: si falla, simplemente no se cachea.
  }
}

/**
 * Comprueba contra la pasarela un pedido CANCELLED con pago y, si resulta pagado, lo completa (se reanima si hay hueco o se reembolsa: ver completeOrder).
 * `complete` es completeOrder/completeShopOrder ya enlazado. Nunca lanza. Devuelve el resultado para la pantalla; el llamante vuelve a leer el pedido.
 */
export async function checkCancelledOrderPayment(params: {
  kind: 'entradas' | 'tienda';
  request: Request;
  order: { id: string; paymentProvider: string | null; paymentId: string | null; createdAt?: Date };
  complete: (paid: PaidInfo) => Promise<CompleteOutcome>;
}): Promise<PaymentCheck> {
  const { kind, order } = params;
  if (!order.paymentProvider || order.paymentProvider === 'mock' || !order.paymentId) return 'none';
  try {
    const cached = await readCache(order.id);
    if (cached) return cached;
    const limit = await rateLimit('order-paycheck', `${getClientIp(params.request)}:${order.id}`, CHECKS_PER_MINUTE, 60_000);
    if (!limit.ok) return 'checking'; // sin consultar: lo último conocido no existe, y «comprobando» es lo honesto

    const provider = await getPaymentProviderByName(order.paymentProvider, await accountScopeForOrder(kind, order));
    const result = await provider.verifyPayment(order.paymentId);
    const status = effectiveStatus(result);
    if (status === 'PAID') {
      const outcome = await params.complete(result);
      if (outcome === 'revived' || outcome === 'already_completed') return 'paid';
      if (outcome === 'refunded_late') return 'refunded';
      await writeCache(order.id, 'checking');
      return 'checking'; // pago confirmado que no se ha podido resolver solo (ya se avisó al operador): sigue «comprobando»
    }
    if (status === 'REFUNDED') {
      await writeCache(order.id, 'refunded');
      return 'refunded';
    }
    // La pasarela no se puede consultar o el cobro está en curso: no se sabe.
    if (status === 'UNKNOWN' || status === 'PROCESSING') {
      await writeCache(order.id, 'checking');
      return 'checking';
    }
    // EXPIRED, FAILED o PENDING (sesión sin pagar): la pasarela confirma que no hay cobro.
    await writeCache(order.id, 'not_paid');
    return 'not_paid';
  } catch (error) {
    console.error('[payment-check]', error instanceof Error ? error.message : error);
    return 'checking';
  }
}
