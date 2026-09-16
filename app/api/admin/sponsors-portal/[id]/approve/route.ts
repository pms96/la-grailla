export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

class StaleStatusError extends Error {}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsorId = params?.id;
    const prompt = await prisma.sponsorVideoPrompt.findUnique({ where: { sponsorId } });
    if (!prompt) {
      return NextResponse.json({ error: 'Este sponsor todavía no tiene un prompt generado' }, { status: 400 });
    }

    // Guarda de estado: solo se puede aprobar desde PROMPT_GENERADO — evita
    // "aprobar" un sponsor ya aprobado o ya rechazado. El updateMany guardado
    // y la actualización del prompt van en la misma transacción, como antes.
    await prisma.$transaction(async (tx) => {
      const claim = await tx.sponsor.updateMany({
        where: { id: sponsorId, status: 'PROMPT_GENERADO' },
        data: { status: 'APROBADO_PARA_VIDEO' },
      });
      if (claim.count === 0) {
        throw new StaleStatusError();
      }
      await tx.sponsorVideoPrompt.update({
        where: { sponsorId },
        data: { approvedAt: new Date(), approvedById: session.user?.id },
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof StaleStatusError) {
      return NextResponse.json({ error: 'El sponsor no está en estado "prompt generado"' }, { status: 409 });
    }
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/approve');
  }
}
