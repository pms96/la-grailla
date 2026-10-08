import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { getBaseUrl } from '@/lib/url';
import { ProviderNotConfiguredError, WebhookRejected, getPaymentProviderByName } from '@/lib/payment-adapter';
import { resolveExpiredCheckout, resolvePaidCheckout } from '@/lib/order-reconciliation';

/* Entrada común de los webhooks de cobro: `/api/webhooks/{proveedor}`. Cada proveedor aporta SU verificación de firma y su traducción
 * a un evento neutro (`PaymentProvider.parseWebhook`); aquí está todo lo demás, igual para todos: idempotencia, reconciliación del pedido
 * (entradas o tienda) y la respuesta. Un webhook nunca se corta por fase de licencia ni por módulo apagado: es dinero en vuelo. */

const KNOWN_PROVIDERS = new Set(['stripe', 'sumup']);

/** Las filas de Stripe ya guardadas son el `evt_…` a secas; el resto de proveedores llevan su nombre delante para no chocar entre sí. */
const processedKey = (provider: string, eventId: string) => (provider === 'stripe' ? eventId : `${provider}:${eventId}`);

export async function handleProviderWebhook(providerName: string, request: Request): Promise<NextResponse> {
  const name = providerName.toLowerCase();
  const route = `POST /api/webhooks/${name}`;
  if (!KNOWN_PROVIDERS.has(name)) return NextResponse.json({ error: 'Proveedor no encontrado' }, { status: 404 });

  try {
    let provider;
    try {
      provider = await getPaymentProviderByName(name);
    } catch (err) {
      // Falta una credencial: se dice así (400). Una credencial cifrada que no se puede abrir es otra cosa y sigue siendo un 500.
      if (err instanceof ProviderNotConfiguredError) {
        console.error(`[${route}] ${err.message}`);
        return NextResponse.json({ error: `${name === 'stripe' ? 'Stripe' : 'SumUp'} no está configurado` }, { status: 400 });
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
    if (event.kind === 'payment_succeeded') await resolvePaidCheckout(event.orderId, baseUrl);
    else if (event.kind === 'payment_expired') await resolveExpiredCheckout(event.orderId);

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
    return handleApiError(error, route);
  }
}
