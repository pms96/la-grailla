export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { notifySponsorStatus } from '@/lib/sponsor-portal';
import { getBaseUrl } from '@/lib/url';

// Único disparador de aviso genérico de estado — el rechazo automático vive
// en reject/route.ts, la invitación inicial y el reenvío en sus propias rutas.
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const result = await notifySponsorStatus(params?.id, getBaseUrl(request), session.user?.id);
    return NextResponse.json({ success: result.success, error: result.error });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/notify');
  }
}
