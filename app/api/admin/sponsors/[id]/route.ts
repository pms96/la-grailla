export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getBaseUrl } from '@/lib/url';
import { planSeasonMove, recordSeasonMove } from '@/lib/contabilidad/season-reassign';
import { seasonLinkEnabled, withoutSeasonLink } from '@/lib/modules/season-link';
import { ensureSponsorPortalInvite, buildSponsorPortalUrl } from '@/lib/sponsor-portal';
import { actorFromSession, diffFields, recordAdminAudit } from '@/lib/admin-audit';

const updateSponsorSchema = z.object({
  status: z.enum(['PENDING', 'CONTACTED', 'ACCEPTED', 'REJECTED']).optional(),
  adminNotes: z.string().optional().nullable(),
  temporadaId: z.string().optional().nullable(),
  // El formulario público ya no pide el tipo de patrocinio — lo asigna el
  // admin aquí, junto con el precio que le corresponde.
  sponsorType: z.string().min(1).max(100).optional().nullable(),
});

// Vista unificada de un sponsor: el lead (SponsorRequest) + su portal
// (Sponsor, si ya fue aceptado) + el historial de comunicaciones — todo lo
// que /admin/sponsors/[id] necesita en una sola petición.
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsorRequest = await prisma.sponsorRequest.findUnique({
      where: { id: params?.id },
      include: {
        // El nombre de la temporada es de Contabilidad: sin ese módulo no se devuelve.
        ...(seasonLinkEnabled() ? { temporada: { select: { id: true, nombre: true } } } : {}),
        emailLogs: { orderBy: { createdAt: 'desc' } },
        // El historial de emails de arriba (sponsorRequest.emailLogs) ya es el
        // superset completo — todo email post-aceptación se registra con
        // ambos sponsorRequestId y sponsorId, así que no hace falta repetirlo
        // aquí también.
        sponsor: {
          include: {
            currentAsset: true,
            assets: { orderBy: { uploadedAt: 'desc' } },
            videoPrompt: true,
            generationLogs: { orderBy: { createdAt: 'desc' } },
          },
        },
      },
    });
    if (!sponsorRequest) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }
    const portalUrl = sponsorRequest.sponsor
      ? buildSponsorPortalUrl(getBaseUrl(request), sponsorRequest.sponsor.id, sponsorRequest.sponsor.portalTokenVersion)
      : null;
    return NextResponse.json(withoutSeasonLink({ ...sponsorRequest, portalUrl }));
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/sponsors/[id]');
  }
}

export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = updateSponsorSchema.parse(await request.json());
    // H-019: mover el patrocinio a o desde una temporada cerrada da 423; entre abiertas queda en la auditoría.
    const seasonMove = body?.temporadaId !== undefined && seasonLinkEnabled() ? await planSeasonMove(async () => (await prisma.sponsorRequest.findUnique({ where: { id: params?.id }, select: { temporadaId: true } }))?.temporadaId, body.temporadaId) : null;
    if (seasonMove?.block) return seasonMove.block;
    const before = await prisma.sponsorRequest.findUnique({ where: { id: params?.id }, select: { status: true, sponsorType: true } });
    // H-018/H-021: aceptar el patrocinio o asignarle tipo (que fija su precio) deja rastro de → a, en la misma transacción que el cambio.
    const sponsor = await prisma.$transaction(async (tx) => {
      const updated = await tx.sponsorRequest.update({
        where: { id: params?.id },
        data: {
          status: body?.status,
          adminNotes: body?.adminNotes,
          temporadaId: body?.temporadaId === undefined || !seasonLinkEnabled() ? undefined : body.temporadaId || null,
          sponsorType: body?.sponsorType === undefined ? undefined : body.sponsorType || null,
        },
      });
      const cambios = before ? diffFields(before, updated, ['status', 'sponsorType'] as const) : {};
      if (Object.keys(cambios).length > 0) {
        await recordAdminAudit(tx, actorFromSession(session), request, { action: 'sponsor.update', targetType: 'SponsorRequest', targetId: updated.id, meta: { companyName: updated.companyName, cambios } });
      }
      return updated;
    });

    await recordSeasonMove(seasonMove, { session, request, targetType: 'SponsorRequest', targetId: params?.id });

    // Se espera el envío (deja de ser fire-and-forget) — aceptar un lead es
    // una acción de baja frecuencia, y así el admin ve al instante si la
    // invitación llegó o falló, en vez de que se pierda en un log de servidor.
    let invite: Awaited<ReturnType<typeof ensureSponsorPortalInvite>> | null = null;
    if (body?.status === 'ACCEPTED') {
      invite = await ensureSponsorPortalInvite(sponsor.id, getBaseUrl(request));
    }

    return NextResponse.json({ ...sponsor, portalUrl: invite?.portalUrl ?? null, invitationEmailSuccess: invite?.emailResult?.success ?? null });
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/sponsors/[id]');
  }
}
