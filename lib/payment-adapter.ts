/* Payment Adapter Pattern — extensible payment gateway abstraction */
import type Stripe from 'stripe';
import { getConfig, getConfigOrThrow, hasConfigRow } from '@/lib/config';
import { isModuleEnabled } from '@/lib/modules/runtime';
import { stripeExpiresAt, sumUpValidUntil } from '@/lib/checkout-hold';

export interface PaymentSession {
  sessionId: string;
  checkoutUrl: string;
  provider: string;
}

/**
 * Estado de un cobro según la pasarela, normalizado. `success` de PaymentResult equivale a `status === 'PAID'`.
 *
 * La verificación es de TRES resultados, y quien libera stock debe distinguirlos (P0-06):
 *  - pagado: `PAID`;
 *  - no pagado con la pasarela CONFIRMÁNDOLO: `EXPIRED`, `FAILED` y `PENDING` (sesión aún abierta, sin pago);
 *  - no se sabe: `UNKNOWN` (la consulta falló: clave caducada o mal puesta, pasarela caída, respuesta ilegible) y `PROCESSING`.
 * `PROCESSING` = la sesión está completa pero el cobro sigue en curso (medios de pago asíncronos: el dinero está en camino). Un pedido
 * en ese estado NUNCA se libera por tiempo. Un fallo de consulta jamás es «no pagado»: eso cancelaría ventas que pueden estar cobradas.
 */
export type PaymentStatus = 'PAID' | 'PENDING' | 'PROCESSING' | 'FAILED' | 'EXPIRED' | 'REFUNDED' | 'UNKNOWN';

/** Estado efectivo de un resultado: un adaptador que no informa de `status` solo dice pagado/no pagado, y «no pagado» sin más no es una confirmación. */
export function effectiveStatus(result: Pick<PaymentResult, 'success' | 'status'>): PaymentStatus {
  if (result.status) return result.status;
  return result.success ? 'PAID' : 'UNKNOWN';
}

export interface PaymentResult {
  success: boolean;
  paymentId: string;
  provider: string;
  error?: string;
  /** Estado rico del cobro. Ausente = el adaptador solo sabe decir pagado / no pagado (ver `effectiveStatus`). Una verificación que FALLA lleva siempre `UNKNOWN` + `error`. */
  status?: PaymentStatus;
  /** Importe y moneda que la pasarela dice haber cobrado (para poder contrastarlo con el pedido). */
  amount?: number;
  currency?: string;
}

/** Lo que un proveedor sabe hacer. Quien lo usa pregunta aquí en vez de comparar nombres de proveedor. */
export interface ProviderCapabilities {
  /** Avisa por webhook firmado (implementa `parseWebhook`). Sin webhook, el cron de reconciliación es la red de seguridad. */
  webhooks: boolean;
  /** Página de pago alojada por la pasarela (redirección). */
  hostedCheckout: boolean;
  refunds: boolean;
  partialRefunds: boolean;
  /** Acepta una clave de idempotencia en el reembolso: un reintento no duplica el dinero devuelto. */
  idempotentRefunds: boolean;
  /** Puede cerrar una sesión de pago aún abierta (`cancelPayment`), para que un pedido liberado no se pueda pagar después. */
  cancelCheckout: boolean;
  /** Cobro presencial con el móvil o un lector (Tap to Pay). Aún sin implementar en ningún adaptador. */
  inPerson: boolean;
}

/** Lo que significa un webhook ya verificado, igual para todos los proveedores. */
export type WebhookEvent =
  | { kind: 'payment_succeeded'; eventId: string; orderId: string }
  | { kind: 'payment_expired'; eventId: string; orderId: string }
  | { kind: 'ignored'; eventId?: string };

/** Un webhook que se rechaza (firma inválida, proveedor sin configurar…) con el código HTTP que corresponde. */
export class WebhookRejected extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'WebhookRejected';
  }
}

/** Falta una credencial del proveedor en la configuración del cliente (no es un fallo de la pasarela). */
export class ProviderNotConfiguredError extends Error {
  constructor(
    message: string,
    public readonly provider: string
  ) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

/** Cobro presencial (Tap to Pay): declarado para el producto de cobro en persona; ningún adaptador lo implementa todavía. */
export interface InPersonPaymentParams {
  amount: number;
  currency: string;
  description: string;
  orderId: string;
  metadata?: Record<string, string>;
}
export interface InPersonPayment {
  paymentId: string;
  provider: string;
  /** Lo que necesita la app del dispositivo para iniciar el cobro (token de conexión, intención de pago…). */
  clientSecret?: string;
}

export interface RefundResult {
  success: boolean;
  refundId?: string;
  error?: string;
}

/** Resultado de cerrar una sesión de pago viva: `ok` = la pasarela confirma que ya no se puede pagar (la cerramos ahora o ya estaba cerrada). */
export interface CancelPaymentResult {
  ok: boolean;
  error?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
}

/** Un cobro pagado según la pasarela (sesión de Checkout), normalizado para la conciliación inversa pasarela → BD (OB-11). */
export interface PaidSession {
  id: string;
  /** `metadata.orderId` con el que se creó la sesión; null si no lo lleva (no es una venta de esta plataforma). */
  orderId: string | null;
  /** `metadata.orderType`: `ticket` (entradas) o `shop` (tienda). */
  orderType: string | null;
  amount: number | null;
  currency: string | null;
  createdAt: Date;
  /** El cargo consta reembolsado, total o parcialmente. */
  refunded: boolean;
}

export interface PaidListing {
  sessions: PaidSession[];
  /** La lista se cortó por el tope de páginas o de tiempo: puede haber más cobros que no se han visto. */
  truncated: boolean;
  /** La consulta falló (clave inválida, pasarela caída…); `sessions` lleva lo que se llegó a leer. */
  error?: string;
}

/** ¿Hay un checkout PAGADO con esta referencia (SumUp referencia el checkout con el id de NUESTRO pedido)? */
export interface PaidByReference {
  paid: boolean;
  checkoutId?: string;
  refunded: boolean;
  error?: string;
}

export interface PaymentProvider {
  name: string;
  capabilities: ProviderCapabilities;
  /**
   * Verifica la firma de un webhook y lo traduce a un evento neutro. Lanza `WebhookRejected` si no es válido. Solo existe si
   * `capabilities.webhooks`. El cuerpo se pasa en crudo: la firma se calcula sobre los bytes exactos que envió la pasarela.
   */
  parseWebhook?(rawBody: string, headers: Headers): Promise<WebhookEvent>;
  /** Solo si `capabilities.inPerson`. */
  createInPersonPayment?(params: InPersonPaymentParams): Promise<InPersonPayment>;
  // Comprobación de solo lectura, sin crear ningún cobro ni sesión de pago —
  // pensada para "probar conexión" desde /admin/configuracion ANTES de
  // guardar la credencial, que es cuando de verdad importa detectar una
  // clave inválida (o un espacio/salto de línea pegado sin querer), en vez
  // de enterarse con el primer comprador real fallando en el checkout.
  testConnection(): Promise<ConnectionTestResult>;
  createCheckoutSession(params: {
    amount: number;
    currency: string;
    description: string;
    orderId: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentSession>;
  /**
   * Consulta el estado real del cobro. NUNCA lanza: un fallo (excepción, HTTP no OK, respuesta ilegible) se devuelve como
   * `{ success: false, status: 'UNKNOWN', error }`.
   */
  verifyPayment(paymentId: string): Promise<PaymentResult>;
  /**
   * Cierra la sesión de pago para que ya no se pueda pagar. Solo existe si `capabilities.cancelCheckout`. Nunca lanza. Se usa con el patrón
   * cerrar → volver a verificar → liberar: si la sesión ya estaba pagada el cierre falla y la nueva verificación lo dirá.
   */
  cancelPayment?(paymentId: string): Promise<CancelPaymentResult>;
  /**
   * URL de pago de una sesión que SIGUE abierta, para que el comprador pueda reanudarla (reintento con la misma clave de idempotencia, TI-12 /
   * EN-07). `null` si ya no se puede pagar o no se puede saber. Nunca lanza.
   */
  resumeCheckout?(paymentId: string): Promise<string | null>;
  /**
   * Cobros PAGADOS creados en un intervalo (solo lectura; páginas de 100, con tope de páginas y de tiempo). Solo existe si la pasarela puede listar
   * sus cobros con la referencia de NUESTRO pedido (Stripe: `metadata.orderId`). Es la base de la conciliación inversa diaria: un cobro sin pedido
   * en la BD solo se ve recorriendo la pasarela. Nunca lanza.
   */
  listRecentPaid?(opts: { from: Date; to: Date; maxPages: number; deadline: number }): Promise<PaidListing>;
  /** Búsqueda del cobro de un pedido por su referencia (SumUp no deja listar por fecha con referencia). Nunca lanza. */
  findPaidByReference?(reference: string): Promise<PaidByReference>;
  // idempotencyKey (opcional): identifica de forma estable un mismo intento
  // de reembolso (p.ej. `refund_${orderId}`) para que un timeout/reintento de
  // red hacia la pasarela no acabe creando un segundo reembolso real —
  // Stripe soporta esto de forma nativa; los adaptadores que no lo soporten
  // simplemente lo ignoran.
  refund(paymentId: string, amount?: number, idempotencyKey?: string): Promise<RefundResult>;
}

/* Stripe adapter stub */
/**
 * Normaliza el estado de una sesión de Checkout de Stripe.
 * - `payment_status: 'paid'` manda sobre todo lo demás.
 * - Sesión `open` sin pagar = PENDING de verdad: el comprador aún puede pagar o abandonar.
 * - Sesión `complete` pero sin pagar (`unpaid`/`no_payment_required`) = PROCESSING: medios de pago asíncronos (transferencia, SEPA…), el
 *   comprador ya ha terminado y el dinero está en camino. No es «pendiente»: no se puede liberar por tiempo.
 * - Cualquier otra combinación (o sin `status`) = UNKNOWN: ante la duda, nunca se interpreta como no pagado.
 */
export function mapStripeSessionStatus(session: { payment_status?: string | null; status?: string | null }): PaymentStatus {
  if (session.payment_status === 'paid') return 'PAID';
  if (session.status === 'expired') return 'EXPIRED';
  const unpaid = session.payment_status === 'unpaid' || session.payment_status === 'no_payment_required';
  if (unpaid && session.status === 'open') return 'PENDING';
  if (unpaid && session.status === 'complete') return 'PROCESSING';
  return 'UNKNOWN';
}

/** ¿La sesión está pagada pero su cargo consta como reembolsado, total o parcialmente? Solo se sabe si el cargo viene expandido; si no, se asume que no. */
export function stripeSessionRefunded(session: unknown): boolean {
  const s = session as { payment_status?: string | null; payment_intent?: unknown } | null;
  if (s?.payment_status !== 'paid') return false;
  const pi = s.payment_intent;
  const charge = pi && typeof pi === 'object' ? (pi as { latest_charge?: unknown }).latest_charge : null;
  if (!charge || typeof charge !== 'object') return false;
  const c = charge as { amount_refunded?: unknown; refunded?: unknown };
  return c.refunded === true || (typeof c.amount_refunded === 'number' && c.amount_refunded > 0);
}

export class StripeAdapter implements PaymentProvider {
  name = 'stripe';
  capabilities: ProviderCapabilities = { webhooks: true, hostedCheckout: true, refunds: true, partialRefunds: true, idempotentRefunds: true, cancelCheckout: true, inPerson: false };
  private secretKey: string;
  // Carga perezosa: crear un cobro no exige el secreto del webhook, y si está guardado pero ilegible el error aparece al recibir
  // un webhook (donde se necesita), no al cobrar.
  private loadWebhookSecret: () => Promise<string>;

  constructor(secretKey: string, loadWebhookSecret: () => Promise<string> = async () => '') {
    this.secretKey = secretKey;
    this.loadWebhookSecret = loadWebhookSecret;
  }

  async parseWebhook(rawBody: string, headers: Headers): Promise<WebhookEvent> {
    const signature = headers.get('stripe-signature');
    if (!signature) throw new WebhookRejected(400, 'Falta la cabecera stripe-signature');
    const webhookSecret = await this.loadWebhookSecret();
    if (!this.secretKey || !webhookSecret) {
      console.error('[webhook stripe] Stripe no está configurado (falta secret key o webhook secret)');
      throw new WebhookRejected(400, 'Stripe no está configurado');
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      console.error('[webhook stripe] Firma inválida:', err instanceof Error ? err.message : err);
      throw new WebhookRejected(400, 'Firma inválida');
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId;
        if (orderId && session.payment_status === 'paid') return { kind: 'payment_succeeded', eventId: event.id, orderId };
        return { kind: 'ignored', eventId: event.id };
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId;
        if (orderId) return { kind: 'payment_expired', eventId: event.id, orderId };
        return { kind: 'ignored', eventId: event.id };
      }
      default:
        return { kind: 'ignored', eventId: event.id };
    }
  }

  // stripe.balance.retrieve() es la comprobación estándar que recomienda la
  // propia documentación de Stripe para validar una secret key: de solo
  // lectura, sin crear nada, y cualquier secret key normal tiene permiso
  // para llamarla.
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });
      await stripe.balance.retrieve();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async createCheckoutSession(params: {
    amount: number;
    currency: string;
    description: string;
    orderId: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentSession> {
    // Dynamic import so Stripe is only loaded when used
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });
    const session = await stripe.checkout.sessions.create(
      {
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: params.currency,
            product_data: { name: params.description },
            unit_amount: Math.round(params.amount * 100),
          },
          quantity: 1,
        }],
        mode: 'payment',
        // Retención corta (P0-04): sin esto la sesión vive 24 h y el pedido retiene aforo/stock todo ese tiempo.
        expires_at: stripeExpiresAt(),
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        customer_email: params.customerEmail,
        metadata: { orderId: params.orderId, ...(params.metadata ?? {}) },
      },
      // Un timeout de red hacia Stripe (la sesión se crea en su lado pero la
      // respuesta no llega) no debe traducirse en una segunda sesión de
      // checkout — con la misma clave, Stripe devuelve la ya creada en vez
      // de facturar/crear un recurso duplicado.
      { idempotencyKey: `checkout_${params.orderId}` }
    );
    return {
      sessionId: session.id,
      checkoutUrl: session.url ?? '',
      provider: 'stripe',
    };
  }

  async verifyPayment(paymentId: string): Promise<PaymentResult> {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });
      // `expand` en la MISMA llamada (sin petición extra): Stripe sigue diciendo `payment_status: 'paid'` en una sesión reembolsada, y el reembolso solo
      // se ve en el cargo (`amount_refunded` > 0 en un reembolso total o parcial; `refunded` solo en el total: https://docs.stripe.com/api/charges/object).
      const session = await stripe.checkout.sessions.retrieve(paymentId, { expand: ['payment_intent.latest_charge'] });
      const status = stripeSessionRefunded(session) ? 'REFUNDED' : mapStripeSessionStatus(session);
      return {
        success: status === 'PAID',
        paymentId: session.id,
        provider: 'stripe',
        status,
        ...(status === 'REFUNDED' ? { error: 'El cobro consta como reembolsado (total o parcialmente) en la pasarela' } : {}),
        ...(status === 'UNKNOWN' ? { error: `Stripe devolvió una sesión en un estado que no se reconoce (status=${session.status}, payment_status=${session.payment_status})` } : {}),
        ...(session.amount_total != null ? { amount: session.amount_total / 100 } : {}),
        ...(session.currency ? { currency: session.currency.toUpperCase() } : {}),
      };
    } catch (err) {
      // Clave caducada o mal puesta, red, Stripe caído…: NO es «no pagado». Con `UNKNOWN` nadie libera nada a partir de este resultado.
      return { success: false, paymentId, provider: 'stripe', status: 'UNKNOWN', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Conciliación inversa (OB-11): sesiones de Checkout pagadas en [from, to]. `expand` anida el cargo para ver reembolsos sin una petición por sesión.
  // Las que no llevan `metadata.orderId` no son ventas de esta plataforma (la cuenta puede usarse para otras cosas) y se devuelven con orderId null.
  async listRecentPaid(opts: { from: Date; to: Date; maxPages: number; deadline: number }): Promise<PaidListing> {
    const sessions: PaidSession[] = [];
    try {
      const Stripe = (await import('stripe')).default;
      // Tiempo propio y sin reintentos de red: el SDK espera 80 s por defecto y la función entera dura 60 (la tarea cuenta con su `deadline`, no con el del SDK).
      const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion, timeout: 10_000, maxNetworkRetries: 0 });
      let startingAfter: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= opts.maxPages || Date.now() >= opts.deadline) return { sessions, truncated: true };
        const res = await stripe.checkout.sessions.list({
          limit: 100,
          // Solo sesiones COMPLETAS: las abiertas y las caducadas (todo intento abandonado deja una) no pueden estar pagadas y se comerían las páginas.
          status: 'complete',
          created: { gte: Math.floor(opts.from.getTime() / 1000), lte: Math.floor(opts.to.getTime() / 1000) },
          expand: ['data.payment_intent.latest_charge'],
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        for (const s of res.data) {
          if (s.payment_status !== 'paid') continue;
          sessions.push({
            id: s.id,
            orderId: s.metadata?.orderId ?? null,
            orderType: s.metadata?.orderType ?? null,
            amount: s.amount_total != null ? s.amount_total / 100 : null,
            currency: s.currency ? s.currency.toUpperCase() : null,
            createdAt: new Date(s.created * 1000),
            refunded: stripeSessionRefunded(s),
          });
        }
        if (!res.has_more || res.data.length === 0) return { sessions, truncated: false };
        startingAfter = res.data[res.data.length - 1].id;
      }
    } catch (err) {
      return { sessions, truncated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // La URL de una sesión sigue siendo válida mientras esté `open`.
  async resumeCheckout(paymentId: string): Promise<string | null> {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });
      const session = await stripe.checkout.sessions.retrieve(paymentId);
      return session.status === 'open' && session.url ? session.url : null;
    } catch {
      return null;
    }
  }

  // Cierra la sesión (`checkout.sessions.expire`): el comprador ya no puede pagarla. Solo se puede cerrar una sesión `open`: si ya estaba
  // completa o pagada, Stripe devuelve error y quien llama vuelve a verificar. Si ya estaba expirada se da por cerrada.
  async cancelPayment(paymentId: string): Promise<CancelPaymentResult> {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });
      try {
        await stripe.checkout.sessions.expire(paymentId);
        return { ok: true };
      } catch (err) {
        const session = await stripe.checkout.sessions.retrieve(paymentId).catch(() => null);
        if (session?.status === 'expired' && session.payment_status !== 'paid') return { ok: true };
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async refund(paymentId: string, amount?: number, idempotencyKey?: string): Promise<RefundResult> {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });
    try {
      const session = await stripe.checkout.sessions.retrieve(paymentId);
      const piId = session.payment_intent as string;
      const refund = await stripe.refunds.create(
        {
          payment_intent: piId,
          ...(amount ? { amount: Math.round(amount * 100) } : {}),
        },
        idempotencyKey ? { idempotencyKey } : undefined
      );
      return { success: true, refundId: refund.id };
    } catch (err) {
      // Ya reembolsado (p. ej. desde el panel de Stripe, o un reintento pasadas las 24 h de la clave de idempotencia): el objetivo está cumplido.
      if ((err as { code?: string } | null)?.code === 'charge_already_refunded') return { success: true };
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/* SumUp adapter — Hosted Checkout (https://developer.sumup.com/online-payments/checkouts/hosted-checkout).
 * La API de SumUp exige `merchant_code` en el body (la API key sola no identifica la cuenta de cobro),
 * y solo devuelve una página de pago real si se pide `hosted_checkout.enabled: true` — sin eso, el
 * endpoint solo crea un recurso de checkout sin URL a la que redirigir al comprador. */
/** Normaliza el estado de un checkout de SumUp (PENDING, FAILED, PAID; cualquier otro, desconocido). */
export function mapSumUpStatus(status: unknown): PaymentStatus {
  switch (status) {
    case 'PAID':
      return 'PAID';
    case 'PENDING':
      return 'PENDING';
    case 'FAILED':
      return 'FAILED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'UNKNOWN';
  }
}

export class SumUpAdapter implements PaymentProvider {
  name = 'sumup';
  // Sin webhook (se confirma al volver del checkout o por el cron) y sin clave de idempotencia en el reembolso.
  capabilities: ProviderCapabilities = { webhooks: false, hostedCheckout: true, refunds: true, partialRefunds: false, idempotentRefunds: false, cancelCheckout: true, inPerson: false };
  private apiKey: string;
  private merchantCode: string;

  constructor(apiKey: string, merchantCode: string) {
    this.apiKey = apiKey;
    this.merchantCode = merchantCode;
  }

  // GET /v0.1/merchants/{code} es de solo lectura y comprueba a la vez la
  // API key (401 si es inválida/caducada) Y que el merchant_code es el que
  // corresponde a esa cuenta (404 si no) — justo las dos formas en las que
  // ya hemos visto fallar esto en producción.
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const response = await fetch(`https://api.sumup.com/v0.1/merchants/${this.merchantCode}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        return { ok: false, error: data?.message || data?.error_message || `SumUp devolvió ${response.status} al comprobar la cuenta` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async createCheckoutSession(params: {
    amount: number;
    currency: string;
    description: string;
    orderId: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentSession> {
    const response = await fetch('https://api.sumup.com/v0.1/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        checkout_reference: params.orderId,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        merchant_code: this.merchantCode,
        description: params.description,
        redirect_url: params.successUrl,
        // Retención corta (P0-04): el checkout no se puede pagar pasado este instante (date-time ISO 8601; sin él no caduca nunca).
        valid_until: sumUpValidUntil(),
        hosted_checkout: { enabled: true },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.message || data?.error_message || `SumUp devolvió ${response.status} al crear el checkout`);
    }
    if (!data?.hosted_checkout_url) {
      throw new Error('SumUp no devolvió una URL de pago (revisa que el Hosted Checkout esté disponible para esta cuenta)');
    }
    return {
      sessionId: data.id,
      checkoutUrl: data.hosted_checkout_url,
      provider: 'sumup',
    };
  }

  async verifyPayment(paymentId: string): Promise<PaymentResult> {
    try {
      const response = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(paymentId)}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return { success: false, paymentId, provider: 'sumup', status: 'UNKNOWN', error: data?.message || `SumUp devolvió ${response.status}` };
      }
      // El checkout sigue en PAID tras un reembolso; el reembolso (total o parcial) se ve en el estado REFUNDED de su transacción
      // (https://developer.sumup.com/api/checkouts/get).
      const refunded = data?.status === 'PAID' && Array.isArray(data?.transactions) && data.transactions.some((t: { status?: string } | null) => t?.status === 'REFUNDED');
      const status: PaymentStatus = refunded ? 'REFUNDED' : mapSumUpStatus(data?.status);
      return {
        success: status === 'PAID',
        paymentId,
        provider: 'sumup',
        status,
        ...(status === 'REFUNDED' ? { error: 'El cobro consta como reembolsado (total o parcialmente) en la pasarela' } : {}),
        ...(status === 'UNKNOWN' ? { error: `SumUp devolvió un estado que no se reconoce (${String(data?.status)})` } : {}),
        ...(typeof data?.amount === 'number' ? { amount: data.amount } : {}),
        ...(typeof data?.currency === 'string' ? { currency: data.currency } : {}),
      };
    } catch (err) {
      // Red, timeout, clave inválida…: no es «no pagado».
      return { success: false, paymentId, provider: 'sumup', status: 'UNKNOWN', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // GET /v0.1/checkouts?checkout_reference=… (https://developer.sumup.com/api/checkouts/list) devuelve los checkouts con esa referencia; la nuestra es el id
  // del pedido. Es la única forma de encontrar un cobro cuyo pedido no llegó a guardar el `paymentId`: el historial de transacciones de SumUp no lleva la referencia.
  async findPaidByReference(reference: string): Promise<PaidByReference> {
    try {
      const response = await fetch(`https://api.sumup.com/v0.1/checkouts?checkout_reference=${encodeURIComponent(reference)}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) return { paid: false, refunded: false, error: data?.message || `SumUp devolvió ${response.status}` };
      const list: { id?: string; status?: string; transactions?: { status?: string }[] }[] = Array.isArray(data) ? data : [];
      const hit = list.find((c) => c?.status === 'PAID');
      if (!hit) return { paid: false, refunded: false };
      const refunded = Array.isArray(hit.transactions) && hit.transactions.some((t) => t?.status === 'REFUNDED');
      return { paid: true, checkoutId: hit.id, refunded };
    } catch (err) {
      return { paid: false, refunded: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // GET /v0.1/checkouts/{id} devuelve `hosted_checkout_url` y `status` (https://developer.sumup.com/api/checkouts/get): reanudable mientras esté PENDING.
  async resumeCheckout(paymentId: string): Promise<string | null> {
    try {
      const response = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(paymentId)}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      return data?.status === 'PENDING' && typeof data?.hosted_checkout_url === 'string' ? data.hosted_checkout_url : null;
    } catch {
      return null;
    }
  }

  // Desactiva el checkout (DELETE /v0.1/checkouts/{id}, https://developer.sumup.com/api/checkouts/deactivate): 200 = desactivado (queda
  // EXPIRED); 409 CHECKOUT_PROCESSED = ya procesado, no se puede desactivar (puede estar pagado: quien llama vuelve a verificar).
  async cancelPayment(paymentId: string): Promise<CancelPaymentResult> {
    try {
      const response = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(paymentId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return { ok: true };
      const data = await response.json().catch(() => null);
      return { ok: false, error: data?.message || data?.error_message || `SumUp devolvió ${response.status} al desactivar el checkout` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // SumUp reembolsa TRANSACCIONES, no checkouts: lo que guardamos en el pedido (`paymentId`) es el id del checkout, así que primero se lee
  // el checkout para sacar la transacción cobrada y luego se reembolsa esa
  // (POST /v1.0/merchants/{merchant_code}/payments/{transaction_id}/refunds; sin importe = reembolso total).
  // SumUp no tiene cabecera de idempotencia: si la transacción ya consta como reembolsada se da por hecho, para que un reintento tras un
  // fallo posterior (p. ej. al guardar el pedido) no se quede atascado en el 409 de SumUp. El parámetro de idempotencia se acepta por la interfaz común.
  async refund(paymentId: string, amount?: number, _idempotencyKey?: string): Promise<RefundResult> {
    const headers = { 'Authorization': `Bearer ${this.apiKey}` };
    const message = (data: any, status: number, what: string): string => data?.message || data?.detail || data?.error_message || `SumUp devolvió ${status} al ${what}`;
    try {
      const lookup = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(paymentId)}`, { headers, signal: AbortSignal.timeout(15_000) });
      const checkout = await lookup.json().catch(() => null);
      if (!lookup.ok) return { success: false, error: message(checkout, lookup.status, 'consultar el pago') };

      const transactions: { id?: string; status?: string; amount?: number }[] = Array.isArray(checkout?.transactions) ? checkout.transactions : [];
      const charged = transactions.find((t) => t?.status === 'SUCCESSFUL' && t.id);
      if (!charged) {
        const refunded = transactions.find((t) => t?.status === 'REFUNDED' && t.id);
        return refunded ? { success: true, refundId: refunded.id } : { success: false, error: 'SumUp no tiene ninguna transacción cobrada en este pago: no hay nada que reembolsar' };
      }

      // Un importe menor que lo cobrado es un reembolso parcial; el total (o sin importe) se pide sin él.
      const partial = typeof amount === 'number' && typeof charged.amount === 'number' && amount > 0 && amount < charged.amount - 0.005;
      const response = await fetch(`https://api.sumup.com/v1.0/merchants/${encodeURIComponent(this.merchantCode)}/payments/${encodeURIComponent(charged.id as string)}/refunds`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(partial ? { amount } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        return { success: false, error: message(data, response.status, 'reembolsar') };
      }
      return { success: true, refundId: charged.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/* Mock adapter for testing / fallback when no gateway is configured */
export class MockPaymentAdapter implements PaymentProvider {
  name = 'mock';
  capabilities: ProviderCapabilities = { webhooks: false, hostedCheckout: true, refunds: true, partialRefunds: true, idempotentRefunds: true, cancelCheckout: false, inPerson: false };

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true };
  }

  async createCheckoutSession(params: {
    amount: number;
    currency: string;
    description: string;
    orderId: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail: string;
  }): Promise<PaymentSession> {
    return {
      sessionId: `mock_${params.orderId}`,
      checkoutUrl: params.successUrl + '?mock=true',
      provider: 'mock',
    };
  }

  async verifyPayment(paymentId: string): Promise<PaymentResult> {
    return { success: true, paymentId, provider: 'mock', status: 'PAID' };
  }

  async refund(): Promise<RefundResult> {
    return { success: true, refundId: 'mock_refund' };
  }
}

/* Construye un adaptador para una pasarela concreta, independientemente de cuál
 * esté activa ahora mismo en /admin/configuracion. Necesario para verificar un
 * pago más tarde (p. ej. al volver del checkout) usando la pasarela con la que
 * REALMENTE se creó ese pedido, no la que esté seleccionada en ese momento. */
export async function getPaymentProviderByName(gateway: string, scope: PaymentScope = 'entradas'): Promise<PaymentProvider> {
  const keys = await paymentKeys(scope);

  if (gateway === 'stripe') {
    // .trim(): una key guardada con un espacio/salto de línea invisible (copia
    // y pega desde el dashboard de la pasarela) rompe el header Authorization
    // y la pasarela responde 401 sin más contexto — nunca es un valor válido.
    const secretKey = (await getConfigOrThrow(keys.stripeSecret)).trim();
    if (!secretKey) throw new ProviderNotConfiguredError(`Stripe está activo pero falta ${keys.stripeSecret} en /admin/configuracion`, 'stripe');
    return new StripeAdapter(secretKey, async () => (await getConfigOrThrow(keys.stripeWebhook)).trim());
  }

  if (gateway === 'sumup') {
    const [apiKey, merchantCode] = await Promise.all([
      getConfigOrThrow(keys.sumupKey),
      getConfig(keys.sumupMerchant),
    ]);
    const trimmedApiKey = apiKey.trim();
    const trimmedMerchantCode = merchantCode.trim();
    if (!trimmedApiKey || !trimmedMerchantCode) {
      throw new ProviderNotConfiguredError(`SumUp está activo pero falta ${keys.sumupKey} o ${keys.sumupMerchant} en /admin/configuracion`, 'sumup');
    }
    return new SumUpAdapter(trimmedApiKey, trimmedMerchantCode);
  }

  return new MockPaymentAdapter();
}

/** A qué cuenta de cobro pertenece un pedido: cada módulo con venta tiene la suya. */
export type PaymentScope = 'entradas' | 'tienda';

const ENTRADAS_KEYS = {
  gateway: 'payment_gateway',
  stripeSecret: 'stripe_secret_key',
  stripeWebhook: 'stripe_webhook_secret',
  sumupKey: 'sumup_api_key',
  sumupMerchant: 'sumup_merchant_code',
} as const;

const TIENDA_KEYS = {
  gateway: 'shop_payment_gateway',
  stripeSecret: 'shop_stripe_secret_key',
  stripeWebhook: 'shop_stripe_webhook_secret',
  sumupKey: 'shop_sumup_api_key',
  sumupMerchant: 'shop_sumup_merchant_code',
} as const;

/**
 * Claves de configuración de la cuenta de cobro de un módulo. Entradas y Tienda NO comparten cuenta: la tienda lee sus claves `shop_*`.
 * Continuidad: un cliente que ya cobraba la tienda con la cuenta de Entradas sigue igual hasta que guarde la pasarela de la tienda
 * (no existe todavía la fila `shop_payment_gateway`); en cuanto la guarda, la tienda usa solo las suyas. Esa continuidad solo existe si
 * el cliente tiene Entradas (sin él no hay otra cuenta de la que heredar).
 */
async function paymentKeys(scope: PaymentScope): Promise<{ gateway: string; stripeSecret: string; stripeWebhook: string; sumupKey: string; sumupMerchant: string }> {
  if (scope === 'entradas') return ENTRADAS_KEYS;
  if (isModuleEnabled('entradas') && !(await hasConfigRow(TIENDA_KEYS.gateway))) return ENTRADAS_KEYS;
  return TIENDA_KEYS;
}

/* Factory — lee la pasarela activa desde la config de la BD.
 * Importante: solo se cae a Mock cuando la pasarela activa es explícitamente
 * "mock" o no hay ninguna configurada. Si el admin eligió Stripe/SumUp pero le
 * falta una credencial, lanzamos un error en vez de caer a Mock en silencio —
 * lo contrario simula un pago aceptado sin cobrar nada real, y el fallo de
 * configuración nunca se detectaría hasta producción. */
export async function getPaymentProvider(scope: PaymentScope = 'entradas'): Promise<PaymentProvider> {
  const activeGateway = await getConfig((await paymentKeys(scope)).gateway);
  const resolvedGateway = activeGateway || 'mock';

  // En producción, "mock" completa pedidos como pagados sin cobrar nada real
  // — es el comportamiento correcto para desarrollo/tests, pero si se llega
  // a producción sin haber configurado Stripe/SumUp en /admin/configuracion
  // (o si alguien lo cambia a "mock" por error), regalaría entradas/productos
  // indefinidamente sin ningún aviso. Mejor romper el checkout con un error
  // claro que dejar pasar ventas gratis silenciosamente.
  if (resolvedGateway === 'mock' && process.env.NODE_ENV === 'production') {
    throw new Error(
      'La pasarela de pago está en modo "mock" en producción — no se puede completar la venta. Configura Stripe o SumUp en /admin/configuracion.'
    );
  }

  return getPaymentProviderByName(resolvedGateway, scope);
}

/**
 * Huella de la CUENTA de cobro de un módulo (pasarela + credencial), sin exponer la credencial; null si no hay pasarela real. Dos módulos con la
 * misma huella cobran en la misma cuenta (Tienda hereda la de Entradas hasta que guarda la suya): la conciliación recorre cada cuenta UNA vez.
 */
export async function paymentAccountFingerprint(scope: PaymentScope = 'entradas'): Promise<string | null> {
  const keys = await paymentKeys(scope);
  const gateway = (await getConfig(keys.gateway)) || 'mock';
  const { createHash } = await import('node:crypto');
  const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
  if (gateway === 'stripe') return `stripe:${hash((await getConfigOrThrow(keys.stripeSecret)).trim())}`;
  if (gateway === 'sumup') return `sumup:${hash((await getConfigOrThrow(keys.sumupKey)).trim(), (await getConfig(keys.sumupMerchant)).trim())}`;
  return null;
}
