export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sendTicketsEmail } from '@/lib/tickets';
import { getBaseUrl } from '@/lib/url';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { handleApiError } from '@/lib/api-error';

const sendTicketsSchema = z.object({
  force: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: { orderId: string } }) {
  try {
    const limit = rateLimit('send-tickets', getClientIp(request), 5, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiados envios. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    let force = false;
    try {
      const body = sendTicketsSchema.parse(await request.json());
      force = Boolean(body?.force);
    } catch {}

    const result = await sendTicketsEmail(params?.orderId, force, getBaseUrl(request));
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error, 'POST /api/orders/[orderId]/send-tickets');
  }
}
