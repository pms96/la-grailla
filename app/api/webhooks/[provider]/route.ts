export const dynamic = 'force-dynamic';

import { handleProviderWebhook } from '@/lib/payments/webhook-handler';

export async function POST(request: Request, { params }: { params: { provider: string } }) {
  return handleProviderWebhook(params.provider, request);
}
