import { prisma } from '@/lib/prisma';
import { sendMail, escapeHtml } from '@/lib/mailer';
import { signSponsorAccess } from '@/lib/access-token';
import type { SponsorPortalStatus } from '@prisma/client';

export function buildSponsorPortalUrl(baseUrl: string, sponsorId: string): string {
  return `${baseUrl}/patrocinadores/portal/${sponsorId}?t=${encodeURIComponent(signSponsorAccess(sponsorId))}`;
}

// Una vez el admin ya ha marcado el sponsor como revisado (LISTO_PARA_GENERAR
// o más adelante), un cambio en el logo o en el formulario guiado invalida esa
// revisión — sin esto, el admin podía generar el prompt sobre un logo/
// descripción distintos a los que de verdad vio. PENDIENTE_MATERIALES se dejaba
// tal cual porque ahí el sponsor sigue completando su primer envío.
export function nextStatusAfterEdit(current: SponsorPortalStatus, hasAsset: boolean, hasAnswers: boolean): SponsorPortalStatus {
  if (current === 'PENDIENTE_MATERIALES') {
    return hasAsset && hasAnswers ? 'PENDIENTE_REVISION' : 'PENDIENTE_MATERIALES';
  }
  return 'PENDIENTE_REVISION';
}

/**
 * Se llama al aceptar un SponsorRequest. Crea el Sponsor (una sola vez, el
 * @unique en sponsorRequestId lo garantiza) y manda la invitación al portal —
 * la única notificación automática de todo el flujo; el resto son manuales
 * desde el panel admin.
 */
export async function ensureSponsorPortalInvite(sponsorRequestId: string, baseUrl: string) {
  const existing = await prisma.sponsor.findUnique({ where: { sponsorRequestId } });
  if (existing) return existing;

  const request = await prisma.sponsorRequest.findUnique({ where: { id: sponsorRequestId } });
  if (!request) return null;

  const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId } });
  const portalUrl = buildSponsorPortalUrl(baseUrl, sponsor.id);

  try {
    await sendMail({
      to: request.email,
      subject: 'Acceso a tu portal de patrocinador — La Grailla',
      html: `
        <p>Hola ${escapeHtml(request.contactName || request.companyName)},</p>
        <p>¡Buenas noticias! ${escapeHtml(request.companyName)} ha sido aceptado como patrocinador de La Grailla.</p>
        <p>Ya puedes acceder a tu portal privado para subir tu logo y contarnos cómo quieres que sea
          el vídeo de tu marca en pantalla LED:</p>
        <p><a href="${portalUrl}">${portalUrl}</a></p>
        <p>Guarda este enlace — es tu acceso al portal. No caduca: puedes volver cuando quieras,
          las veces que quieras, para ver en qué punto está tu solicitud o cambiar tus materiales
          mientras siga en revisión.</p>
      `,
    });
  } catch (error) {
    console.error('No se pudo enviar la invitación al portal de sponsor:', error instanceof Error ? error.message : error);
  }

  return sponsor;
}
