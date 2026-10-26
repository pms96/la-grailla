export const dynamic = 'force-dynamic';

import { handleProviderWebhook } from '@/lib/payments/webhook-handler';

export async function POST(request: Request, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  return handleProviderWebhook(params.provider, request);
}
