export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

class StaleStatusError extends Error {}
class NoVideoError extends Error {}

// Camino alternativo a /approve para sponsors que no tienen ninguna imagen
// de logo que animar (solo dieron un vídeo de referencia) — ver
// generate/route.ts, que exige una imagen para poder llamar a Abacus.AI. En
// vez de forzar una generación por IA que siempre fallaría, esto salta
// directamente a APROBADO_PARA_VIDEO usando el propio vídeo del sponsor
// como vídeo final (el admin puede reemplazarlo después si lo edita).
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsorId = params?.id;

    const updated = await prisma.$transaction(async (tx) => {
      const video = await tx.sponsorAsset.findFirst({
        where: { sponsorId, fileType: { startsWith: 'video/' } },
        orderBy: { uploadedAt: 'desc' },
      });
      if (!video) {
        throw new NoVideoError();
      }

      const claim = await tx.sponsor.updateMany({
        where: { id: sponsorId, status: { in: ['PENDIENTE_REVISION', 'LISTO_PARA_GENERAR'] } },
        data: {
          status: 'APROBADO_PARA_VIDEO',
          finalVideoUrl: video.url,
          finalVideoFileName: video.fileName,
          finalVideoSize: video.fileSize,
          finalVideoUploadedAt: new Date(),
        },
      });
      if (claim.count === 0) {
        throw new StaleStatusError();
      }

      return tx.sponsor.findUnique({ where: { id: sponsorId } });
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof NoVideoError) {
      return NextResponse.json({ error: 'Este sponsor no tiene ningún vídeo subido' }, { status: 400 });
    }
    if (error instanceof StaleStatusError) {
      return NextResponse.json({ error: 'El sponsor no está en un estado válido para esta acción' }, { status: 409 });
    }
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/approve-with-video');
  }
}
