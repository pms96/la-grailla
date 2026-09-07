export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { getConfig } from '@/lib/config';
import { handleApiError } from '@/lib/api-error';
import { resolveExpiredCheckout, resolvePaidCheckout } from '@/lib/order-reconciliation';
import { getBaseUrl } from '@/lib/url';
import { prisma } from '@/lib/prisma';

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

    // Stripe reintenta la entrega si no respondemos 2xx a tiempo (timeout,
    // deploy en curso, error transitorio) — el mismo evento puede llegar más
    // de una vez. Comprobación rápida aquí para no reprocesar de más en el
    // caso común (reintento de un evento que YA se procesó con éxito); el
    // registro de "procesado" se hace más abajo, después de procesar de
    // verdad (ver comentario junto al insert) — PAY-05.
    if (event.id) {
      const alreadyProcessed = await prisma.processedWebhookEvent.findUnique({ where: { id: event.id } });
      if (alreadyProcessed) {
        return NextResponse.json({ received: true, duplicate: true });
      }
    }

    const baseUrl = getBaseUrl(request);

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId;
        if (orderId && session.payment_status === 'paid') {
          await resolvePaidCheckout(orderId, baseUrl);
        }
        break;
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId;
        if (orderId) {
          await resolveExpiredCheckout(orderId);
        }
        break;
      }
      default:
        break;
    }

    // PAY-05: el insert va DESPUÉS de procesar con éxito, no antes. Si
    // resolvePaidCheckout/resolveExpiredCheckout lanzara una excepción (fallo
    // transitorio de BD, bug), la versión anterior ya había marcado el evento
    // como "procesado" antes de intentar procesarlo — el reintento automático
    // de Stripe (en minutos, no en los ~5 min del cron de reconciliación)
    // chocaba con la constraint única y salía como "duplicate" sin volver a
    // intentar el pedido, dejándolo PENDING hasta el siguiente paso del cron.
    // Con el insert al final, un reintento tras un fallo vuelve a ejecutar el
    // procesamiento real — completeOrder/completeShopOrder ya son
    // idempotentes (updateMany condicionado a PENDING), así que repetir el
    // trabajo en el caso normal es seguro.
    if (event.id) {
      try {
        await prisma.processedWebhookEvent.create({ data: { id: event.id } });
      } catch (err) {
        // P2002: dos entregas casi simultáneas del mismo evento pasaron
        // ambas el check de arriba antes de que ninguna insertara — ya se ha
        // procesado dos veces de forma idempotente, no es un error real.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    return handleApiError(error, 'POST /api/webhooks/stripe');
  }
}
