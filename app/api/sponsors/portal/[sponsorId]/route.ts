export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { allowSponsorAccess, getTokenFromRequest } from '@/lib/access-token';

export async function GET(request: Request, { params }: { params: { sponsorId: string } }) {
  try {
    const sponsorId = params?.sponsorId;
    // portalTokenVersion se necesita ANTES de poder verificar el token —
    // se lee en una consulta ligera separada porque el token puede no ser
    // válido y no queremos exponer el resto de la fila en ese caso.
    const versionRow = await prisma.sponsor.findUnique({ where: { id: sponsorId }, select: { portalTokenVersion: true } });
    if (!versionRow || !(await allowSponsorAccess(sponsorId, versionRow.portalTokenVersion, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const sponsor = await prisma.sponsor.findUnique({
      where: { id: sponsorId },
      include: {
        // Solo lo que el portal necesita mostrar — sponsorRequest también
        // tiene adminNotes (notas internas, nunca pensadas para el sponsor)
        // y otros campos de gestión que no le corresponde ver a quien solo
        // tiene el token del portal.
        sponsorRequest: { select: { companyName: true, contactName: true, sponsorType: true } },
        currentAsset: true,
        // Historial completo de materiales enviados — nunca se borran, cada
        // subida es una fila nueva (ver comentario en SponsorAsset).
        assets: { orderBy: { uploadedAt: 'desc' } },
        // Solo lo que el sponsor debe poder ver de su propio prompt: el
        // texto y si ya está aprobado — nada de logs de generación ni de
        // quién lo aprobó internamente.
        videoPrompt: { select: { promptEs: true, promptEn: true, approvedAt: true } },
      },
    });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }

    // El vídeo final solo se muestra una vez el sponsor está formalmente
    // aprobado — si el admin lo sube antes (mientras aún prepara/revisa), no
    // se expone todavía aunque la fila ya tenga la URL.
    const { finalVideoUrl, finalVideoFileName, finalVideoSize, finalVideoUploadedAt, ...rest } = sponsor;
    const finalVideo =
      sponsor.status === 'APROBADO_PARA_VIDEO' && finalVideoUrl
        ? { url: finalVideoUrl, fileName: finalVideoFileName, size: finalVideoSize, uploadedAt: finalVideoUploadedAt }
        : null;

    return NextResponse.json({ ...rest, finalVideo });
  } catch (error) {
    return handleApiError(error, 'GET /api/sponsors/portal/[sponsorId]');
  }
}
