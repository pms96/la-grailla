export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { allowSponsorAccess, getTokenFromRequest } from '@/lib/access-token';

export async function GET(request: Request, props: { params: Promise<{ sponsorId: string }> }) {
  const params = await props.params;
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
        // Solo lo que el portal necesita mostrar/editar — sponsorRequest
        // también tiene adminNotes (notas internas, nunca pensadas para el
        // sponsor), status y temporadaId, que son de gestión interna y no le
        // corresponde ver a quien solo tiene el token del portal.
        sponsorRequest: {
          select: {
            companyName: true,
            contactName: true,
            email: true,
            phone: true,
            website: true,
            sponsorType: true,
            message: true,
            consentAt: true,
          },
        },
        currentAsset: true,
        // Historial completo de materiales enviados — nunca se borran, cada
        // subida es una fila nueva (ver comentario en SponsorAsset).
        assets: { orderBy: { uploadedAt: 'desc' } },
        // El prompt en sí (promptEs/promptEn) ya no se expone al sponsor —
        // es una herramienta interna para producir el vídeo, no algo pensado
        // para que lo lea literalmente. Lo que ve el sponsor en ese paso es
        // el aviso de pago pendiente o, si ya pagó, el vídeo final.
      },
    });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }

    // El vídeo final solo se muestra una vez el sponsor está formalmente
    // aprobado Y ha pagado — si el admin lo sube o aprueba antes (el
    // pipeline interno no depende del pago, ver mark-paid/route.ts), el
    // sponsor sigue viendo el aviso de pago pendiente en vez del vídeo.
    const { finalVideoUrl, finalVideoFileName, finalVideoSize, finalVideoUploadedAt } = sponsor;
    const finalVideo =
      sponsor.status === 'APROBADO_PARA_VIDEO' && sponsor.isPaid && finalVideoUrl
        ? { url: finalVideoUrl, fileName: finalVideoFileName, size: finalVideoSize, uploadedAt: finalVideoUploadedAt }
        : null;

    // Lista cerrada: solo lo que pinta la pantalla del portal. Antes se devolvía la fila entera (`...rest`) y salían la investigación
    // privada del admin (brandContext), el error de envío del email y los contadores internos de generación.
    return NextResponse.json({
      id: sponsor.id,
      status: sponsor.status,
      guidedAnswers: sponsor.guidedAnswers,
      freeText: sponsor.freeText,
      isPaid: sponsor.isPaid,
      sponsorRequest: sponsor.sponsorRequest,
      currentAsset: sponsor.currentAsset,
      assets: sponsor.assets,
      finalVideo,
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/sponsors/portal/[sponsorId]');
  }
}
