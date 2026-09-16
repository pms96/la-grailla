export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { resendSponsorPortalInvite } from '@/lib/sponsor-portal';
import { getBaseUrl } from '@/lib/url';

// Acción explícita "Reenviar invitación" — distinta del botón genérico
// "Notificar por email": copy propio de reenvío, sin depender del estado actual.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { portalUrl, emailResult } = await resendSponsorPortalInvite(params?.id, getBaseUrl(request), session.user?.id);
    return NextResponse.json({ success: emailResult.success, error: emailResult.error, portalUrl });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/resend-invite');
  }
}
