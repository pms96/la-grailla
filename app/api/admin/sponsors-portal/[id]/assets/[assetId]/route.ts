export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { del } from '@vercel/blob';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

// Elimina un material subido por el sponsor (logo, vídeo de referencia,
// PDF...) — a diferencia del resto de SponsorAsset, que nunca se borran
// (histórico de subidas), esto es un borrado real a petición del admin o del
// propio sponsor (ver también app/api/sponsors/portal/[sponsorId]/assets/[assetId]/route.ts).
// Sin restricción de estado del pipeline: el admin puede limpiar materiales
// en cualquier momento.
export async function DELETE(_request: Request, { params }: { params: { id: string; assetId: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const asset = await prisma.sponsorAsset.findUnique({ where: { id: params?.assetId } });
    if (!asset || asset.sponsorId !== params?.id) {
      return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
    }

    // currentAssetId es @unique en Sponsor — hay que repuntarlo o vaciarlo
    // ANTES de borrar la fila, o Prisma rechaza el delete por la FK. Se hace
    // en una transacción para que ambos pasos sean atómicos.
    await prisma.$transaction(async (tx) => {
      const sponsor = await tx.sponsor.findUnique({ where: { id: params.id } });
      if (sponsor?.currentAssetId === asset.id) {
        const nextCurrent = await tx.sponsorAsset.findFirst({
          where: { sponsorId: params.id, id: { not: asset.id }, fileType: { startsWith: 'image/' } },
          orderBy: { uploadedAt: 'desc' },
        });
        await tx.sponsor.update({ where: { id: params.id }, data: { currentAssetId: nextCurrent?.id ?? null } });
      }
      await tx.sponsorAsset.delete({ where: { id: asset.id } });
    });

    await del(asset.url).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/sponsors-portal/[id]/assets/[assetId]');
  }
}
