export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { allowSponsorAccess, getTokenFromRequest } from '@/lib/access-token';

export async function GET(request: Request, { params }: { params: { sponsorId: string } }) {
  try {
    const sponsorId = params?.sponsorId;
    if (!(await allowSponsorAccess(sponsorId, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const sponsor = await prisma.sponsor.findUnique({
      where: { id: sponsorId },
      include: {
        sponsorRequest: true,
        currentAsset: true,
        // Solo lo que el sponsor debe poder ver de su propio prompt: el
        // texto y si ya está aprobado — nada de logs de generación ni de
        // quién lo aprobó internamente.
        videoPrompt: { select: { promptEs: true, promptEn: true, approvedAt: true } },
      },
    });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }

    return NextResponse.json(sponsor);
  } catch (error) {
    return handleApiError(error, 'GET /api/patrocinadores/[sponsorId]');
  }
}
