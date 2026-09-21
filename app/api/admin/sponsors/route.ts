export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { ensureSponsorPortalInvite } from '@/lib/sponsor-portal';
import { normalizePhone } from '@/lib/phone';
import { getBaseUrl } from '@/lib/url';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsors = await prisma.sponsorRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: { sponsor: { select: { id: true, status: true, invitationEmailStatus: true, isPaid: true, isCollaboration: true } } },
    });
    return NextResponse.json(sponsors ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/sponsors');
  }
}

const createSponsorSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactName: z.string().min(1).max(200),
  // Opcional a propósito — el admin puede dar de alta sin email todavía y
  // compartir el enlace del portal por WhatsApp/copiar enlace; el sponsor lo
  // añade él mismo desde ahí (ver /api/sponsors/portal/[sponsorId]/datos).
  email: z.union([z.string().email().max(255), z.literal('')]).optional(),
  phone: z.string().max(30).optional().nullable(),
  website: z.string().max(300).optional().nullable(),
  sponsorType: z.string().min(1),
  message: z.string().max(5000).optional().nullable(),
  // Acuerdo ya cerrado por teléfono/WhatsApp/en persona — el admin da de alta
  // directamente en el estado que corresponda, sin pasar por el formulario público.
  status: z.enum(['PENDING', 'CONTACTED', 'ACCEPTED']).default('ACCEPTED'),
});

// Alta manual desde admin — mismo caso de uso que el formulario público, pero
// para acuerdos cerrados por otra vía. Reutiliza ensureSponsorPortalInvite,
// la misma función que dispara la invitación al aceptar un lead normal, para
// no duplicar esa lógica.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = createSponsorSchema.parse(await request.json());

    const sponsorRequest = await prisma.sponsorRequest.create({
      data: {
        companyName: body.companyName,
        contactName: body.contactName,
        email: body.email || null,
        phone: normalizePhone(body.phone),
        website: body.website || null,
        sponsorType: body.sponsorType,
        message: body.message || null,
        status: body.status,
      },
    });

    let invite: Awaited<ReturnType<typeof ensureSponsorPortalInvite>> | null = null;
    if (body.status === 'ACCEPTED') {
      invite = await ensureSponsorPortalInvite(sponsorRequest.id, getBaseUrl(request));
    }

    return NextResponse.json({
      sponsorRequest,
      sponsor: invite?.sponsor ?? null,
      portalUrl: invite?.portalUrl ?? null,
      invitationEmailSuccess: invite?.emailResult?.success ?? null,
    }, { status: 201 });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors');
  }
}
