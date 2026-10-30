import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { getBaseUrl } from '@/lib/url';
import { ProviderNotConfiguredError, WebhookRejected, getPaymentProviderByName, type PaymentScope } from '@/lib/payment-adapter';
import { resolveExpiredCheckout, resolvePaidCheckout } from '@/lib/order-reconciliation';
import { currentTenant } from '@/lib/tenant/context';
import { alertDisputeOpened, applyGatewayRefund } from '@/lib/reconciliation/gateway-refund';

/* Entrada común de los webhooks de cobro: `/api/webhooks/{proveedor}`. Cada proveedor aporta SU verificación de firma y su traducción
 * a un evento neutro (`PaymentProvider.parseWebhook`); aquí está todo lo demás, igual para todos: idempotencia, reconciliación del pedido
 * (entradas o tienda) y la respuesta. Un webhook nunca se corta por fase de licencia ni por módulo apagado: es dinero en vuelo. */

/** Nombre en la URL → proveedor real y cuenta de cobro. La tienda tiene su propia cuenta de Stripe, con su propio endpoint y su secreto de firma. */
const WEBHOOK_TARGETS: Record<string, { provider: string; scope: PaymentScope }> = {
  stripe: { provider: 'stripe', scope: 'entradas' },
  'stripe-tienda': { provider: 'stripe', scope: 'tienda' },
  sumup: { provider: 'sumup', scope: 'entradas' },
};

/** Las filas de Stripe ya guardadas son el `evt_…` a secas; el resto de proveedores llevan su nombre delante para no chocar entre sí. */
const processedKey = (provider: string, eventId: string) => (provider === 'stripe' ? eventId : `${provider}:${eventId}`);
// (`stripe-tienda` lleva su nombre delante: el `evt_…` de otra cuenta de Stripe nunca choca con uno de Entradas.)

export async function handleProviderWebhook(providerName: string, request: Request): Promise<NextResponse> {
  const name = providerName.toLowerCase();
  const route = `POST /api/webhooks/${name}`;
  const target = WEBHOOK_TARGETS[name];
  if (!target) return NextResponse.json({ error: 'Proveedor no encontrado' }, { status: 404 });

  try {
    let provider;
    try {
      provider = await getPaymentProviderByName(target.provider, target.scope);
    } catch (err) {
      // Falta una credencial: se dice así (400). Una credencial cifrada que no se puede abrir es otra cosa y sigue siendo un 500.
      if (err instanceof ProviderNotConfiguredError) {
        console.error(`[${route}] ${err.message}`);
        return NextResponse.json({ error: `${target.provider === 'stripe' ? 'Stripe' : 'SumUp'} no está configurado` }, { status: 400 });
      }
      throw err;
    }
    if (!provider.capabilities.webhooks || !provider.parseWebhook) {
      return NextResponse.json({ error: 'Este proveedor no usa webhooks' }, { status: 404 });
    }

    // El cuerpo se lee en crudo (sin parsear): la firma se calcula sobre los bytes exactos que envió la pasarela.
    const rawBody = await request.text();
    let event;
    try {
      event = await provider.parseWebhook(rawBody, request.headers);
    } catch (err) {
      if (err instanceof WebhookRejected) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }

    // La pasarela reintenta la entrega si no respondemos 2xx a tiempo, así que el mismo evento puede llegar más de una vez. Aquí se
    // evita reprocesar de más en el caso común; el registro de «procesado» va DESPUÉS de procesar de verdad (PAY-05, ver abajo).
    const key = event.eventId ? processedKey(name, event.eventId) : null;
    if (key && (await prisma.processedWebhookEvent.findUnique({ where: { id: key } }))) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    const baseUrl = getBaseUrl(request);
    if (event.kind === 'payment_succeeded' || event.kind === 'payment_expired') {
      const resolved = event.kind === 'payment_succeeded' ? await resolvePaidCheckout(event.orderId, baseUrl, { amount: event.amount, currency: event.currency }) : await resolveExpiredCheckout(event.orderId);
      if (resolved === null) {
        // OB-03: el `orderId` no existe en la BD de ESTE cliente (webhook de otro entorno o de otro cliente, pedido borrado, metadata errónea):
        // un cobro sin pedido. No se marca como procesado (nada se procesó) y queda en el log con todo lo necesario para localizarlo. Se
        // responde 200 igualmente: un reintento no lo arreglaría y una pasarela con eventos ajenos (p. ej. webhook de pruebas) reintentaría
        // sin fin; el 200 + `unmatched` no lo enmascara porque no hay fila de «procesado».
        console.error(
          `[webhook] webhook.order_not_found ${JSON.stringify({ tenantId: currentTenant()?.tenantId ?? '-', provider: target.provider, route: name, kind: event.kind, eventId: event.eventId, orderId: event.orderId })}`
        );
        return NextResponse.json({ received: true, unmatched: true });
      }
    }

    // P1-01: dinero devuelto fuera de la app (reembolso en el panel de la pasarela, contracargo perdido) y disputas abiertas. Mismo trato que un pago:
    // un pedido que no existe en ESTA BD no se marca como procesado (nada se procesó) y queda en el log.
    if (event.kind === 'payment_refunded' || event.kind === 'dispute_opened') {
      const handled =
        event.kind === 'payment_refunded'
          ? (await applyGatewayRefund({ orderId: event.orderId, full: event.full, refunded: event.refunded, total: event.total, source: event.source })) !== 'missing'
          : await alertDisputeOpened(event.orderId, event.amount, event.reason);
      if (!handled) {
        console.error(
          `[webhook] webhook.order_not_found ${JSON.stringify({ tenantId: currentTenant()?.tenantId ?? '-', provider: target.provider, route: name, kind: event.kind, eventId: event.eventId, orderId: event.orderId })}`
        );
        return NextResponse.json({ received: true, unmatched: true });
      }
    }

    // PAY-05: el insert va DESPUÉS de procesar con éxito. Si la reconciliación lanzara una excepción (fallo transitorio de BD, un bug), un
    // evento ya marcado como procesado saldría como «duplicate» en el reintento y el pedido se quedaría PENDING. Con el insert al final,
    // el reintento repite el trabajo, que es idempotente (completeOrder/completeShopOrder son updateMany condicionados a PENDING).
    if (key) {
      try {
        await prisma.processedWebhookEvent.create({ data: { id: key } });
      } catch (err) {
        // P2002: dos entregas casi simultáneas pasaron el check antes de que ninguna insertara; ya se procesó dos veces de forma idempotente.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    }
    return NextResponse.json({ received: true });
  } catch (error) {
    // Con proveedor y tipo de cuenta: un 500 en un webhook es dinero en vuelo y se avisa a Sentry con ese contexto.
    return handleApiError(error, route, { provider: target.provider, kind: target.scope });
  }
}
