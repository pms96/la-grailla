import { prisma, type SponsorRecord } from '@/lib/prisma';
import { sendMail, escapeHtml, type SendMailResult } from '@/lib/mailer';
import { signSponsorAccess } from '@/lib/access-token';
import type { SponsorEmailType, SponsorPortalStatus, SponsorRequest } from '@prisma/client';
// Alias local — el resto de este archivo ya se refería al tipo como `Sponsor`.
type Sponsor = SponsorRecord;

export function buildSponsorPortalUrl(baseUrl: string, sponsorId: string, tokenVersion: number): string {
  return `${baseUrl}/sponsors/portal/${sponsorId}?t=${encodeURIComponent(signSponsorAccess(sponsorId, tokenVersion))}`;
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

const STATUS_NOTIFY_MESSAGES: Record<string, string> = {
  PROMPT_GENERADO: 'Hemos preparado una propuesta de vídeo para tu marca.',
  APROBADO_PARA_VIDEO: '¡Tu vídeo ha sido aprobado y entra en producción!',
  RECHAZADO: 'Ha habido un problema con tu solicitud de patrocinio. Nos pondremos en contacto contigo.',
};

function copyForType(
  type: SponsorEmailType,
  { contactName, companyName, portalUrl, status }: { contactName: string; companyName: string; portalUrl: string; status?: SponsorPortalStatus }
): { subject: string; html: string } {
  const greeting = `<p>Hola ${escapeHtml(contactName || companyName)},</p>`;

  switch (type) {
    case 'PORTAL_INVITE':
      return {
        subject: 'Acceso a tu portal de patrocinador — La Grailla',
        html: `
          ${greeting}
          <p>¡Buenas noticias! ${escapeHtml(companyName)} ha sido aceptado como patrocinador de La Grailla.</p>
          <p>Ya puedes acceder a tu portal privado para subir tu logo y contarnos cómo quieres que sea
            el vídeo de tu marca en pantalla LED:</p>
          <p><a href="${portalUrl}">${portalUrl}</a></p>
          <p>Guarda este enlace — es tu acceso al portal. No caduca: puedes volver cuando quieras,
            las veces que quieras, para ver en qué punto está tu solicitud o cambiar tus materiales
            mientras siga en revisión.</p>
        `,
      };
    case 'PORTAL_INVITE_RESEND':
      return {
        subject: 'Aquí tienes de nuevo tu acceso al portal — La Grailla',
        html: `
          ${greeting}
          <p>Nos has pedido que te reenviemos el acceso a tu portal de patrocinador de La Grailla —
            aquí lo tienes de nuevo:</p>
          <p><a href="${portalUrl}">${portalUrl}</a></p>
          <p>Si no habías perdido el enlace anterior, puedes ignorar este correo — sigue siendo el mismo portal.</p>
        `,
      };
    case 'REJECTION':
      return {
        subject: 'Sobre tu solicitud de patrocinio — La Grailla',
        html: `
          ${greeting}
          <p>Gracias por el interés de ${escapeHtml(companyName)} en patrocinar La Grailla.</p>
          <p>Esta vez no hemos podido seguir adelante con la solicitud. Si quieres más detalles o
            te gustaría intentarlo en una futura edición, escríbenos y lo hablamos.</p>
        `,
      };
    case 'STATUS_NOTIFY':
    default: {
      const message = (status && STATUS_NOTIFY_MESSAGES[status]) ?? 'Hay novedades sobre tu patrocinio en La Grailla.';
      return {
        subject: 'Novedades sobre tu patrocinio — La Grailla',
        html: `
          ${greeting}
          <p>${message}</p>
          <p>Puedes ver el estado completo, y la propuesta de vídeo si ya está lista, en tu portal:</p>
          <p><a href="${portalUrl}">${portalUrl}</a></p>
        `,
      };
    }
  }
}

/**
 * Envía un email de ciclo de vida del sponsor y registra el intento en
 * SponsorEmailLog (éxito o fallo) — mismo patrón que PromptGenerationLog:
 * historial inmutable, nunca se pierde en un console.error silencioso.
 *
 * Requiere `sponsorRequest.email` no nulo — los llamantes deben comprobarlo
 * antes (SponsorRequest.email es opcional: un sponsor dado de alta sin email
 * todavía no tiene a quién escribir, y eso no es un fallo de envío).
 */
async function sendSponsorLifecycleEmail(
  type: SponsorEmailType,
  {
    sponsor,
    sponsorRequest,
    baseUrl,
    sentById,
  }: { sponsor: Sponsor; sponsorRequest: Omit<SponsorRequest, 'email'> & { email: string }; baseUrl: string; sentById?: string | null }
): Promise<SendMailResult> {
  const portalUrl = buildSponsorPortalUrl(baseUrl, sponsor.id, sponsor.portalTokenVersion);
  const { subject, html } = copyForType(type, {
    contactName: sponsorRequest.contactName,
    companyName: sponsorRequest.companyName,
    portalUrl,
    status: sponsor.status,
  });

  const result = await sendMail({ to: sponsorRequest.email, subject, html });

  await prisma.sponsorEmailLog.create({
    data: {
      sponsorId: sponsor.id,
      sponsorRequestId: sponsorRequest.id,
      type,
      recipient: sponsorRequest.email,
      success: result.success,
      error: result.success ? null : (result.error ?? 'Error desconocido'),
      sentById: sentById ?? null,
    },
  });

  return result;
}

export type EnsureInviteResult = { sponsor: Sponsor; portalUrl: string; emailResult: SendMailResult };

/**
 * Se llama al aceptar un SponsorRequest (o al darlo de alta manual ya
 * aceptado). Crea el Sponsor (una sola vez, el @unique en sponsorRequestId lo
 * garantiza) y envía la invitación al portal, esperando el resultado para
 * poder mostrarlo al admin al instante — antes era fire-and-forget y un fallo
 * de SMTP se perdía en un console.error sin que nadie se enterara.
 */
export async function ensureSponsorPortalInvite(sponsorRequestId: string, baseUrl: string): Promise<EnsureInviteResult> {
  const existing = await prisma.sponsor.findUnique({ where: { sponsorRequestId } });
  if (existing) {
    return {
      sponsor: existing,
      portalUrl: buildSponsorPortalUrl(baseUrl, existing.id, existing.portalTokenVersion),
      emailResult: { success: existing.invitationEmailStatus === 'SENT', transport: 'none' },
    };
  }

  const request = await prisma.sponsorRequest.findUnique({ where: { id: sponsorRequestId } });
  if (!request) {
    throw new Error(`SponsorRequest ${sponsorRequestId} no encontrado al intentar crear su portal`);
  }

  const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId } });

  // Sin email no hay a quién escribir — el admin comparte el enlace a mano
  // (copiar/WhatsApp) y el propio sponsor puede añadir su email más tarde
  // desde el portal. No se marca como fallo: invitationEmailStatus se queda
  // en null ("aún no se ha intentado"), no en 'FAILED'.
  if (!request.email) {
    return {
      sponsor,
      portalUrl: buildSponsorPortalUrl(baseUrl, sponsor.id, sponsor.portalTokenVersion),
      emailResult: { success: false, transport: 'none' },
    };
  }

  const emailResult = await sendSponsorLifecycleEmail('PORTAL_INVITE', { sponsor, sponsorRequest: { ...request, email: request.email }, baseUrl });

  const updated = await prisma.sponsor.update({
    where: { id: sponsor.id },
    data: {
      invitationEmailStatus: emailResult.success ? 'SENT' : 'FAILED',
      invitationEmailError: emailResult.success ? null : (emailResult.error ?? 'Error desconocido'),
      invitationSentAt: new Date(),
    },
  });

  return { sponsor: updated, portalUrl: buildSponsorPortalUrl(baseUrl, updated.id, updated.portalTokenVersion), emailResult };
}

/** Reenvío explícito del acceso al portal, distinto de la invitación inicial y del aviso genérico de estado. */
export async function resendSponsorPortalInvite(sponsorId: string, baseUrl: string, sentById?: string | null): Promise<EnsureInviteResult> {
  const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId }, include: { sponsorRequest: true } });
  if (!sponsor) throw new Error(`Sponsor ${sponsorId} no encontrado`);
  if (!sponsor.sponsorRequest.email) {
    return {
      sponsor,
      portalUrl: buildSponsorPortalUrl(baseUrl, sponsor.id, sponsor.portalTokenVersion),
      emailResult: { success: false, transport: 'none', error: 'Este sponsor todavía no tiene email guardado' },
    };
  }

  const emailResult = await sendSponsorLifecycleEmail('PORTAL_INVITE_RESEND', {
    sponsor,
    sponsorRequest: { ...sponsor.sponsorRequest, email: sponsor.sponsorRequest.email },
    baseUrl,
    sentById,
  });

  const updated = await prisma.sponsor.update({
    where: { id: sponsorId },
    data: {
      invitationEmailStatus: emailResult.success ? 'SENT' : 'FAILED',
      invitationEmailError: emailResult.success ? null : (emailResult.error ?? 'Error desconocido'),
      invitationSentAt: new Date(),
    },
  });

  return { sponsor: updated, portalUrl: buildSponsorPortalUrl(baseUrl, updated.id, updated.portalTokenVersion), emailResult };
}

/** Notificación genérica de cambio de estado — botón "Notificar por email" del admin. */
export async function notifySponsorStatus(sponsorId: string, baseUrl: string, sentById?: string | null): Promise<SendMailResult> {
  const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId }, include: { sponsorRequest: true, videoPrompt: true } });
  if (!sponsor) throw new Error(`Sponsor ${sponsorId} no encontrado`);
  if (!sponsor.sponsorRequest.email) {
    return { success: false, transport: 'none', error: 'Este sponsor todavía no tiene email guardado' };
  }

  const result = await sendSponsorLifecycleEmail('STATUS_NOTIFY', {
    sponsor,
    sponsorRequest: { ...sponsor.sponsorRequest, email: sponsor.sponsorRequest.email },
    baseUrl,
    sentById,
  });

  if (sponsor.videoPrompt) {
    await prisma.sponsorVideoPrompt.update({ where: { sponsorId: sponsor.id }, data: { notifiedAt: new Date() } });
  }

  return result;
}

/** Aviso automático de rechazo — se dispara desde la propia acción de rechazar, sin depender de un segundo clic del admin. */
export async function notifySponsorRejection(sponsorId: string, baseUrl: string): Promise<SendMailResult> {
  const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId }, include: { sponsorRequest: true } });
  if (!sponsor) throw new Error(`Sponsor ${sponsorId} no encontrado`);
  if (!sponsor.sponsorRequest.email) {
    return { success: false, transport: 'none', error: 'Este sponsor todavía no tiene email guardado' };
  }
  return sendSponsorLifecycleEmail('REJECTION', { sponsor, sponsorRequest: { ...sponsor.sponsorRequest, email: sponsor.sponsorRequest.email }, baseUrl });
}

/**
 * Invalida el enlace del portal actual sin tocar NEXTAUTH_SECRET ni afectar a
 * otros sponsors/pedidos/entradas — incrementa la versión del token, así
 * cualquier enlace firmado con la versión anterior deja de validar.
 */
export async function regenerateSponsorPortalToken(sponsorId: string, baseUrl: string): Promise<string> {
  const sponsor = await prisma.sponsor.update({ where: { id: sponsorId }, data: { portalTokenVersion: { increment: 1 } } });
  return buildSponsorPortalUrl(baseUrl, sponsor.id, sponsor.portalTokenVersion);
}
