export const dynamic = 'force-dynamic';

import { handleProviderWebhook } from '@/lib/payments/webhook-handler';

// La URL que ya está configurada en el panel de Stripe de cada cliente. El resto de proveedores entran por /api/webhooks/[provider].
export async function POST(request: Request) {
  return handleProviderWebhook('stripe', request);
}
