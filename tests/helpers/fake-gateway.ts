import type { CancelPaymentResult, PaymentProvider, PaymentResult, RefundResult, WebhookEvent } from '@/lib/payment-adapter';

/* Pasarela FALSA e inyectable para probar el ciclo de vida del pedido pendiente con la BD real y sin red. Cada test que la usa hace:
 *
 *   vi.mock('@/lib/payment-adapter', async (orig) => {
 *     const actual = await orig<typeof import('@/lib/payment-adapter')>();
 *     const { gateway, fakeProvider } = await import('../helpers/fake-gateway');
 *     return { ...actual, getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (gateway.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)),
 *              getPaymentProvider: async (s?: 'entradas' | 'tienda') => (gateway.active ? fakeProvider() : actual.getPaymentProvider(s)) };
 *   });
 *
 * y programa lo que dirá la pasarela con `gateway.script(paymentId, …)`: una secuencia de resultados de `verifyPayment` (el último se repite)
 * o un `Error` (la verificación FALLA, como una clave caducada o una caída). Lo que pasó queda en `gateway.calls`. */

type Scripted = PaymentResult | Error;

export const gateway = {
  active: false,
  cancelCheckout: true,
  scripts: new Map<string, Scripted[]>(),
  cancelResults: new Map<string, CancelPaymentResult | Error>(),
  refundResult: { success: true, refundId: 're_fake' } as RefundResult | Error,
  calls: [] as { op: 'verify' | 'cancel' | 'refund'; paymentId: string; args?: unknown[] }[],
  /** Los parámetros con que se pidió cada sesión de pago (para comprobar `cancelUrl`, importe…). */
  sessions: [] as { orderId: string; cancelUrl: string; successUrl: string; amount: number }[],
  /** Si no es null, `resumeCheckout` devuelve esta URL (la sesión sigue abierta). */
  resumeUrl: null as string | null,
  /** Si es true, crear la sesión falla (la pasarela no responde). */
  failCreate: false,
  /** Pagos que la pasarela da por REEMBOLSADOS (hechos por la app o a mano en el panel): `verifyPayment` los devuelve como REFUNDED. */
  refunded: new Set<string>(),
  /** Retardo (ms) de un reembolso en curso: permite que dos entregas simultáneas se solapen. */
  refundDelayMs: 0,
  /** Claves de idempotencia con un reembolso EN CURSO: una segunda petición con la misma clave falla («idempotency_key_in_use», como Stripe). */
  inFlight: new Set<string>(),
  /** Retardo (ms) de cada `verifyPayment` (una pasarela lenta) y, medido, el máximo de verificaciones simultáneas. */
  verifyDelayMs: 0,
  activeVerifies: 0,
  maxConcurrentVerifies: 0,
  /** Si es true, un segundo reembolso de un pago ya reembolsado FALLA (como SumUp, sin idempotencia). Si no, devuelve el mismo éxito (como Stripe con la misma clave). */
  strictRefunds: false,

  reset() {
    this.active = false;
    this.cancelCheckout = true;
    this.scripts.clear();
    this.cancelResults.clear();
    this.refundResult = { success: true, refundId: 're_fake' };
    this.calls = [];
    this.sessions = [];
    this.resumeUrl = null;
    this.failCreate = false;
    this.refunded.clear();
    this.refundDelayMs = 0;
    this.inFlight.clear();
    this.strictRefunds = false;
    this.verifyDelayMs = 0;
    this.activeVerifies = 0;
    this.maxConcurrentVerifies = 0;
  },
  /** Qué responde `verifyPayment(paymentId)`, en orden (el último se repite). */
  script(paymentId: string, ...results: Scripted[]) {
    this.scripts.set(paymentId, results);
  },
  count(op: 'verify' | 'cancel' | 'refund', paymentId?: string) {
    return this.calls.filter((c) => c.op === op && (!paymentId || c.paymentId === paymentId)).length;
  },
};

export const paid = (paymentId: string, amount?: number): PaymentResult => ({ success: true, paymentId, provider: 'fake', status: 'PAID', ...(amount !== undefined ? { amount, currency: 'EUR' } : {}) });
export const state = (paymentId: string, status: NonNullable<PaymentResult['status']>): PaymentResult => ({ success: false, paymentId, provider: 'fake', status });
/** Lo que devuelve un adaptador cuando la consulta FALLA (clave inválida, caída…). */
export const unknown = (paymentId: string, error = 'No autorizado'): PaymentResult => ({ success: false, paymentId, provider: 'fake', status: 'UNKNOWN', error });

export function fakeProvider(): PaymentProvider {
  return {
    name: 'fake',
    capabilities: { webhooks: true, hostedCheckout: true, refunds: true, partialRefunds: true, idempotentRefunds: true, cancelCheckout: gateway.cancelCheckout, inPerson: false },
    async testConnection() {
      return { ok: true };
    },
    async parseWebhook(rawBody: string): Promise<WebhookEvent> {
      return JSON.parse(rawBody) as WebhookEvent;
    },
    async createCheckoutSession(params) {
      if (gateway.failCreate) throw new Error('pasarela caída');
      gateway.sessions.push({ orderId: params.orderId, cancelUrl: params.cancelUrl, successUrl: params.successUrl, amount: params.amount });
      return { sessionId: `cs_fake_${params.orderId}`, checkoutUrl: `https://pay.example/${params.orderId}`, provider: 'fake' };
    },
    async resumeCheckout() {
      return gateway.resumeUrl;
    },
    async verifyPayment(paymentId: string) {
      gateway.calls.push({ op: 'verify', paymentId });
      gateway.activeVerifies += 1;
      gateway.maxConcurrentVerifies = Math.max(gateway.maxConcurrentVerifies, gateway.activeVerifies);
      try {
        if (gateway.verifyDelayMs > 0) await new Promise((r) => setTimeout(r, gateway.verifyDelayMs));
      } finally {
        gateway.activeVerifies -= 1;
      }
      if (gateway.refunded.has(paymentId)) return { success: false, paymentId, provider: 'fake', status: 'REFUNDED' as const, error: 'reembolsado' };
      const queue = gateway.scripts.get(paymentId);
      if (!queue || queue.length === 0) return unknown(paymentId, 'sin guion para este pago');
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next instanceof Error) throw next; // un adaptador real nunca lanza, pero la reconciliación debe resistirlo igual
      return next;
    },
    ...(gateway.cancelCheckout
      ? {
          async cancelPayment(paymentId: string) {
            gateway.calls.push({ op: 'cancel', paymentId });
            const r = gateway.cancelResults.get(paymentId) ?? { ok: true };
            if (r instanceof Error) throw r;
            return r;
          },
        }
      : {}),
    async refund(paymentId: string, amount?: number, idempotencyKey?: string) {
      gateway.calls.push({ op: 'refund', paymentId, args: [amount, idempotencyKey] });
      const key = idempotencyKey ?? `${paymentId}:no-key`;
      if (gateway.inFlight.has(key)) return { success: false, error: 'idempotency_key_in_use' };
      if (gateway.strictRefunds && gateway.refunded.has(paymentId)) return { success: false, error: 'already refunded' };
      gateway.inFlight.add(key);
      try {
        if (gateway.refundDelayMs > 0) await new Promise((r) => setTimeout(r, gateway.refundDelayMs));
        if (gateway.refundResult instanceof Error) throw gateway.refundResult;
        if (gateway.refundResult.success) gateway.refunded.add(paymentId);
        return gateway.refundResult;
      } finally {
        gateway.inFlight.delete(key);
      }
    },
  };
}
