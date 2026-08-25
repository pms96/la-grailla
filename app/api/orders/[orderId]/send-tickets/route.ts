export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { sendTicketsEmail } from '@/lib/tickets';
import { getBaseUrl } from '@/lib/url';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { handleApiError } from '@/lib/api-error';
import { allowOrderAccess } from '@/lib/access-token';

const sendTicketsSchema = z.object({
  force: z.boolean().optional(),
  softResend: z.boolean().optional(),
  t: z.string().optional(),
});

function isStaff(role: string | undefined): boolean {
  return role === 'ADMIN' || role === 'TAQUILLA';
}

export async function POST(request: Request, { params }: { params: { orderId: string } }) {
  try {
    const limit = await rateLimit('send-tickets', getClientIp(request), 5, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiados envios. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    let force = false;
    let softResend = false;
    let token: string | undefined;
    try {
      const body = sendTicketsSchema.parse(await request.json());
      force = Boolean(body?.force);
      softResend = Boolean(body?.softResend);
      token = body?.t;
    } catch {
      // body vacío
    }

    const session = await getServerSession(authOptions);
    const staff = isStaff(session?.user?.role);

    if (force) {
      if (!staff) {
        return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
      }
    } else if (!(await allowOrderAccess(params?.orderId, token))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const result = await sendTicketsEmail(params?.orderId, force, getBaseUrl(request), {
      softResend: softResend && !force,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error, 'POST /api/orders/[orderId]/send-tickets');
  }
}
