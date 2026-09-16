export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getBaseUrl } from '@/lib/url';
import { ensureSponsorPortalInvite, buildSponsorPortalUrl } from '@/lib/sponsor-portal';

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
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsorRequest = await prisma.sponsorRequest.findUnique({
      where: { id: params?.id },
      include: {
        temporada: { select: { id: true, nombre: true } },
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
    return NextResponse.json({ ...sponsorRequest, portalUrl });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/sponsors/[id]');
  }
}

export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = updateSponsorSchema.parse(await request.json());
    const sponsor = await prisma.sponsorRequest.update({
      where: { id: params?.id },
      data: {
        status: body?.status,
        adminNotes: body?.adminNotes,
        temporadaId: body?.temporadaId === undefined ? undefined : body.temporadaId || null,
        sponsorType: body?.sponsorType === undefined ? undefined : body.sponsorType || null,
      },
    });

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
