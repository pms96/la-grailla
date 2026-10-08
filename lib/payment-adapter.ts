/* Payment Adapter Pattern — extensible payment gateway abstraction */
import type Stripe from 'stripe';
import { getConfig, getConfigOrThrow } from '@/lib/config';

export interface PaymentSession {
  sessionId: string;
  checkoutUrl: string;
  provider: string;
}

/** Estado de un cobro según la pasarela, normalizado. `success` de PaymentResult equivale a `status === 'PAID'`. */
export type PaymentStatus = 'PAID' | 'PENDING' | 'FAILED' | 'EXPIRED' | 'REFUNDED' | 'UNKNOWN';

export interface PaymentResult {
  success: boolean;
  paymentId: string;
  provider: string;
  error?: string;
  /** Estado rico del cobro. Ausente = el adaptador solo sabe decir pagado / no pagado. */
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

export interface ConnectionTestResult {
  ok: boolean;
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
  verifyPayment(paymentId: string): Promise<PaymentResult>;
  // idempotencyKey (opcional): identifica de forma estable un mismo intento
  // de reembolso (p.ej. `refund_${orderId}`) para que un timeout/reintento de
  // red hacia la pasarela no acabe creando un segundo reembolso real —
  // Stripe soporta esto de forma nativa; los adaptadores que no lo soporten
  // simplemente lo ignoran.
  refund(paymentId: string, amount?: number, idempotencyKey?: string): Promise<RefundResult>;
}

/* Stripe adapter stub */
/** Normaliza el estado de una sesión de Checkout de Stripe. */
export function mapStripeSessionStatus(session: { payment_status?: string | null; status?: string | null }): PaymentStatus {
  if (session.payment_status === 'paid') return 'PAID';
  if (session.status === 'expired') return 'EXPIRED';
  if (session.payment_status === 'unpaid' || session.payment_status === 'no_payment_required') return 'PENDING';
  return 'UNKNOWN';
}

export class StripeAdapter implements PaymentProvider {
  name = 'stripe';
  capabilities: ProviderCapabilities = { webhooks: true, hostedCheckout: true, refunds: true, partialRefunds: true, idempotentRefunds: true, inPerson: false };
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
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });
    try {
      const session = await stripe.checkout.sessions.retrieve(paymentId);
      const status = mapStripeSessionStatus(session);
      return {
        success: status === 'PAID',
        paymentId: session.id,
        provider: 'stripe',
        status,
        ...(session.amount_total != null ? { amount: session.amount_total / 100 } : {}),
        ...(session.currency ? { currency: session.currency.toUpperCase() } : {}),
      };
    } catch (err) {
      return { success: false, paymentId, provider: 'stripe', error: err instanceof Error ? err.message : String(err) };
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
  capabilities: ProviderCapabilities = { webhooks: false, hostedCheckout: true, refunds: true, partialRefunds: false, idempotentRefunds: false, inPerson: false };
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
    const response = await fetch(`https://api.sumup.com/v0.1/checkouts/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    const data = await response.json();
    const status: PaymentStatus = response.ok ? mapSumUpStatus(data?.status) : 'UNKNOWN';
    return {
      success: response.ok && data?.status === 'PAID',
      paymentId,
      provider: 'sumup',
      error: response.ok ? undefined : (data?.message || `SumUp devolvió ${response.status}`),
      status,
      ...(response.ok && typeof data?.amount === 'number' ? { amount: data.amount } : {}),
      ...(response.ok && typeof data?.currency === 'string' ? { currency: data.currency } : {}),
    };
  }

  // SumUp no expone un header de idempotencia equivalente en este endpoint;
  // el parámetro se acepta igualmente para cumplir la interfaz común.
  async refund(paymentId: string, _amount?: number, _idempotencyKey?: string): Promise<RefundResult> {
    const response = await fetch(`https://api.sumup.com/v0.1/receipts/${paymentId}/refund`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      return { success: false, error: data?.message || `SumUp devolvió ${response.status}` };
    }
    return { success: true };
  }
}

/* Mock adapter for testing / fallback when no gateway is configured */
export class MockPaymentAdapter implements PaymentProvider {
  name = 'mock';
  capabilities: ProviderCapabilities = { webhooks: false, hostedCheckout: true, refunds: true, partialRefunds: true, idempotentRefunds: true, inPerson: false };

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
export async function getPaymentProviderByName(gateway: string): Promise<PaymentProvider> {
  if (gateway === 'stripe') {
    // .trim(): una key guardada con un espacio/salto de línea invisible (copia
    // y pega desde el dashboard de la pasarela) rompe el header Authorization
    // y la pasarela responde 401 sin más contexto — nunca es un valor válido.
    const secretKey = (await getConfigOrThrow('stripe_secret_key')).trim();
    if (!secretKey) throw new ProviderNotConfiguredError('Stripe está activo pero falta stripe_secret_key en /admin/configuracion', 'stripe');
    return new StripeAdapter(secretKey, async () => (await getConfigOrThrow('stripe_webhook_secret')).trim());
  }

  if (gateway === 'sumup') {
    const [apiKey, merchantCode] = await Promise.all([
      getConfigOrThrow('sumup_api_key'),
      getConfig('sumup_merchant_code'),
    ]);
    const trimmedApiKey = apiKey.trim();
    const trimmedMerchantCode = merchantCode.trim();
    if (!trimmedApiKey || !trimmedMerchantCode) {
      throw new ProviderNotConfiguredError('SumUp está activo pero falta sumup_api_key o sumup_merchant_code en /admin/configuracion', 'sumup');
    }
    return new SumUpAdapter(trimmedApiKey, trimmedMerchantCode);
  }

  return new MockPaymentAdapter();
}

/* Factory — lee la pasarela activa desde la config de la BD.
 * Importante: solo se cae a Mock cuando la pasarela activa es explícitamente
 * "mock" o no hay ninguna configurada. Si el admin eligió Stripe/SumUp pero le
 * falta una credencial, lanzamos un error en vez de caer a Mock en silencio —
 * lo contrario simula un pago aceptado sin cobrar nada real, y el fallo de
 * configuración nunca se detectaría hasta producción. */
export async function getPaymentProvider(): Promise<PaymentProvider> {
  const activeGateway = await getConfig('payment_gateway');
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

  return getPaymentProviderByName(resolvedGateway);
}
