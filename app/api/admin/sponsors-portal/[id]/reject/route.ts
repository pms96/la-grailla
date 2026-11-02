export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { notifySponsorRejection } from '@/lib/sponsor-portal';
import { getBaseUrl } from '@/lib/url';
import { actorFromSession, recordAdminAudit } from '@/lib/admin-audit';

// Rechazar ya no es silencioso: se envía el email de cortesía al sponsor en
// el mismo paso, sin depender de que el admin pulse "Notificar" aparte.
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    // H-239: el rechazo y su rastro van en la misma transacción (no hay rechazo sin auditoría).
    const before = await prisma.$transaction(async (tx) => {
      const prev = await tx.sponsor.findUnique({ where: { id: params?.id }, select: { status: true, isPaid: true, isCollaboration: true, paidAmount: true } });
      const result = await tx.sponsor.updateMany({
        where: { id: params?.id, status: { notIn: ['RECHAZADO', 'APROBADO_PARA_VIDEO'] } },
        data: { status: 'RECHAZADO' },
      });
      if (result.count === 0) return null;
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'sponsor.reject',
        targetType: 'Sponsor',
        targetId: params?.id,
        meta: { from: prev?.status ?? null, wasPaid: prev?.isPaid ?? false, isCollaboration: prev?.isCollaboration ?? false, paidAmount: prev?.paidAmount ?? null },
      });
      return prev;
    });
    if (!before) {
      return NextResponse.json(
        { error: 'El sponsor ya está rechazado o aprobado para vídeo' },
        { status: 409 }
      );
    }

    const emailResult = await notifySponsorRejection(params?.id, getBaseUrl(request));

    const sponsor = await prisma.sponsor.findUnique({ where: { id: params?.id } });
    // Un patrocinio cobrado (y no en especie) sigue sumando a `ingresosPatrocinio` de su temporada aunque se rechace: rechazar no desmarca el cobro por su cuenta (la devolución es manual y la
    // decide el administrador). Se le avisa para que lo desmarque, si procede, desde «Marcar pago».
    const stillCountsAsIncome = Boolean(before.isPaid && !before.isCollaboration);
    return NextResponse.json({ ...sponsor, rejectionEmailSuccess: emailResult.success, stillCountsAsIncome });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/reject');
  }
}
