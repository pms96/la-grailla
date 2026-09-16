export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { notifySponsorRejection } from '@/lib/sponsor-portal';
import { getBaseUrl } from '@/lib/url';

// Rechazar ya no es silencioso: se envía el email de cortesía al sponsor en
// el mismo paso, sin depender de que el admin pulse "Notificar" aparte.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const result = await prisma.sponsor.updateMany({
      where: { id: params?.id, status: { notIn: ['RECHAZADO', 'APROBADO_PARA_VIDEO'] } },
      data: { status: 'RECHAZADO' },
    });
    if (result.count === 0) {
      return NextResponse.json(
        { error: 'El sponsor ya está rechazado o aprobado para vídeo' },
        { status: 409 }
      );
    }

    const emailResult = await notifySponsorRejection(params?.id, getBaseUrl(request));

    const sponsor = await prisma.sponsor.findUnique({ where: { id: params?.id } });
    return NextResponse.json({ ...sponsor, rejectionEmailSuccess: emailResult.success });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/reject');
  }
}
