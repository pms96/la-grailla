export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { regenerateSponsorPortalToken } from '@/lib/sponsor-portal';
import { getBaseUrl } from '@/lib/url';

// Invalida el enlace del portal actual (p. ej. se filtró, o el sponsor lo
// pide de nuevo por seguridad) sin tocar NEXTAUTH_SECRET ni afectar a ningún
// otro sponsor/pedido/entrada — solo incrementa Sponsor.portalTokenVersion.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const portalUrl = await regenerateSponsorPortalToken(params?.id, getBaseUrl(request));
    return NextResponse.json({ portalUrl });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/regenerate-token');
  }
}
