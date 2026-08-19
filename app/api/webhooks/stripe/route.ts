export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getConfig } from '@/lib/config';
import { handleApiError } from '@/lib/api-error';
import { completeOrder, releaseExpiredOrder } from '@/lib/order-reconciliation';

export async function POST(request: Request) {
  try {
    const signature = request.headers.get('stripe-signature');
    if (!signature) {
      return NextResponse.json({ error: 'Falta la cabecera stripe-signature' }, { status: 400 });
    }

    const [secretKey, webhookSecret] = await Promise.all([
      getConfig('stripe_secret_key'),
      getConfig('stripe_webhook_secret'),
    ]);
    if (!secretKey || !webhookSecret) {
      console.error('[POST /api/webhooks/stripe] Stripe no está configurado (falta secret key o webhook secret)');
      return NextResponse.json({ error: 'Stripe no está configurado' }, { status: 400 });
    }

    // El body debe leerse en crudo (sin parsear) — la firma se calcula sobre
    // los bytes exactos que envió Stripe, no sobre un JSON re-serializado.
    const rawBody = await request.text();

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(secretKey, { apiVersion: '2024-04-10' as Stripe.LatestApiVersion });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      console.error('[POST /api/webhooks/stripe] Firma inválida:', err instanceof Error ? err.message : err);
      return NextResponse.json({ error: 'Firma inválida' }, { status: 400 });
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId;
        if (orderId && session.payment_status === 'paid') {
          await completeOrder(orderId);
        }
        break;
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId;
        if (orderId) {
          await releaseExpiredOrder(orderId);
        }
        break;
      }
      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    return handleApiError(error, 'POST /api/webhooks/stripe');
  }
}
