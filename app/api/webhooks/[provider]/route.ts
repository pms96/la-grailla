export const dynamic = 'force-dynamic';
// Tiempo máximo de la función. Tras responder 200 a la pasarela, el email del pedido (PDF + pases + SMTP, hasta ~40 s con los tiempos máximos del
// SMTP) se envía con `after()`, y ese trabajo cuenta para este límite; sin él, la plataforma corta al valor por defecto. Mismo valor que el cron.
export const maxDuration = 60;

import { handleProviderWebhook } from '@/lib/payments/webhook-handler';

export async function POST(request: Request, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  return handleProviderWebhook(params.provider, request);
}
