export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { del } from '@vercel/blob';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { allowSponsorAccess, getTokenFromRequest } from '@/lib/access-token';

// El sponsor puede eliminar sus propios materiales mientras el pipeline
// siga abierto — mismo criterio que editar (logo/datos/creatividad): una
// vez aprobado o rechazado, la solicitud está cerrada y ya no se toca.
export async function DELETE(request: Request, { params }: { params: { sponsorId: string; assetId: string } }) {
  try {
    const sponsorId = params?.sponsorId;
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }
    if (!(await allowSponsorAccess(sponsorId, sponsor.portalTokenVersion, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
    if (sponsor.status === 'APROBADO_PARA_VIDEO' || sponsor.status === 'RECHAZADO') {
      return NextResponse.json(
        { error: 'Esta solicitud ya está cerrada — escríbenos si necesitas cambiar algo.' },
        { status: 409 }
      );
    }

    const asset = await prisma.sponsorAsset.findUnique({ where: { id: params?.assetId } });
    if (!asset || asset.sponsorId !== sponsorId) {
      return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
    }

    // currentAssetId es @unique en Sponsor — hay que repuntarlo o vaciarlo
    // ANTES de borrar la fila, o Prisma rechaza el delete por la FK.
    await prisma.$transaction(async (tx) => {
      if (sponsor.currentAssetId === asset.id) {
        const nextCurrent = await tx.sponsorAsset.findFirst({
          where: { sponsorId, id: { not: asset.id }, fileType: { startsWith: 'image/' } },
          orderBy: { uploadedAt: 'desc' },
        });
        await tx.sponsor.update({ where: { id: sponsorId }, data: { currentAssetId: nextCurrent?.id ?? null } });
      }
      await tx.sponsorAsset.delete({ where: { id: asset.id } });
    });

    await del(asset.url).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/sponsors/portal/[sponsorId]/assets/[assetId]');
  }
}
