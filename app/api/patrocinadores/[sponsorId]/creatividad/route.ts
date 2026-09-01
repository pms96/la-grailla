export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { allowSponsorAccess, getTokenFromRequest } from '@/lib/access-token';
import { nextStatusAfterEdit } from '@/lib/sponsor-portal';

const creativitySchema = z.object({
  guidedAnswers: z.record(z.string()),
  freeText: z.string().optional(),
});

export async function POST(request: Request, { params }: { params: { sponsorId: string } }) {
  try {
    const sponsorId = params?.sponsorId;
    if (!(await allowSponsorAccess(sponsorId, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = creativitySchema.parse(await request.json());

    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }
    if (sponsor.status === 'APROBADO_PARA_VIDEO' || sponsor.status === 'RECHAZADO') {
      return NextResponse.json(
        { error: 'Esta solicitud ya está cerrada — escríbenos si necesitas cambiar algo.' },
        { status: 409 }
      );
    }

    const hasAsset = Boolean(sponsor.currentAssetId);
    const nextStatus = nextStatusAfterEdit(sponsor.status, hasAsset, true);
    const updated = await prisma.sponsor.update({
      where: { id: sponsorId },
      data: { guidedAnswers: body.guidedAnswers, freeText: body.freeText ?? null, status: nextStatus },
    });

    return NextResponse.json(updated);
  } catch (error) {
    return handleApiError(error, 'POST /api/patrocinadores/[sponsorId]/creatividad');
  }
}
