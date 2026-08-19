/* Payment Adapter Pattern — extensible payment gateway abstraction */
import type Stripe from 'stripe';
import { getConfig } from '@/lib/config';

export interface PaymentSession {
  sessionId: string;
  checkoutUrl: string;
  provider: string;
}

export interface PaymentResult {
  success: boolean;
  paymentId: string;
  provider: string;
  error?: string;
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
  refund(paymentId: string, amount?: number): Promise<RefundResult>;
}

/* Stripe adapter stub */
export class StripeAdapter implements PaymentProvider {
  name = 'stripe';
  private secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
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
    const session = await stripe.checkout.sessions.create({
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
    });
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
      return {
        success: session.payment_status === 'paid',
        paymentId: session.id,
        provider: 'stripe',
      };
    } catch (err) {
      return { success: false, paymentId, provider: 'stripe', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async refund(paymentId: string, amount?: number): Promise<RefundResult> {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(this.secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });
    try {
      const session = await stripe.checkout.sessions.retrieve(paymentId);
      const piId = session.payment_intent as string;
      const refund = await stripe.refunds.create({
        payment_intent: piId,
        ...(amount ? { amount: Math.round(amount * 100) } : {}),
      });
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
export class SumUpAdapter implements PaymentProvider {
  name = 'sumup';
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
    return {
      success: response.ok && data?.status === 'PAID',
      paymentId,
      provider: 'sumup',
      error: response.ok ? undefined : (data?.message || `SumUp devolvió ${response.status}`),
    };
  }

  async refund(paymentId: string): Promise<RefundResult> {
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
    return { success: true, paymentId, provider: 'mock' };
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
    const secretKey = (await getConfig('stripe_secret_key')).trim();
    if (!secretKey) throw new Error('Stripe está activo pero falta stripe_secret_key en /admin/configuracion');
    return new StripeAdapter(secretKey);
  }

  if (gateway === 'sumup') {
    const [apiKey, merchantCode] = await Promise.all([
      getConfig('sumup_api_key'),
      getConfig('sumup_merchant_code'),
    ]);
    const trimmedApiKey = apiKey.trim();
    const trimmedMerchantCode = merchantCode.trim();
    if (!trimmedApiKey || !trimmedMerchantCode) {
      throw new Error('SumUp está activo pero falta sumup_api_key o sumup_merchant_code en /admin/configuracion');
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
  return getPaymentProviderByName(activeGateway || 'mock');
}
