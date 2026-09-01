export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { sendMail, escapeHtml } from '@/lib/mailer';
import { buildSponsorPortalUrl } from '@/lib/sponsor-portal';
import { getBaseUrl } from '@/lib/url';

// Único disparador de email tras la invitación inicial — el sponsor no recibe
// nada más hasta que un admin pulsa este botón explícitamente.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsor = await prisma.sponsor.findUnique({
      where: { id: params?.id },
      include: { sponsorRequest: true, videoPrompt: true },
    });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }

    const statusMessages: Record<string, string> = {
      PROMPT_GENERADO: 'Hemos preparado una propuesta de vídeo para tu marca.',
      APROBADO_PARA_VIDEO: '¡Tu vídeo ha sido aprobado y entra en producción!',
      RECHAZADO: 'Ha habido un problema con tu solicitud de patrocinio. Nos pondremos en contacto contigo.',
    };
    const message = statusMessages[sponsor.status] ?? 'Hay novedades sobre tu patrocinio en La Grailla.';
    const portalUrl = buildSponsorPortalUrl(getBaseUrl(request), sponsor.id);

    const result = await sendMail({
      to: sponsor.sponsorRequest.email,
      subject: 'Novedades sobre tu patrocinio — La Grailla',
      html: `
        <p>Hola ${escapeHtml(sponsor.sponsorRequest.contactName || sponsor.sponsorRequest.companyName)},</p>
        <p>${message}</p>
        <p>Puedes ver el estado completo, y la propuesta de vídeo si ya está lista, en tu portal:</p>
        <p><a href="${portalUrl}">${portalUrl}</a></p>
      `,
    });

    if (sponsor.videoPrompt) {
      await prisma.sponsorVideoPrompt.update({
        where: { sponsorId: sponsor.id },
        data: { notifiedAt: new Date() },
      });
    }

    return NextResponse.json({ success: result.success });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/notify');
  }
}
