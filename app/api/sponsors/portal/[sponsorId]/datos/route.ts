export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { allowSponsorAccess, getTokenFromRequest } from '@/lib/access-token';
import { normalizePhone } from '@/lib/phone';

// Deja que el sponsor complete sus propios datos de contacto cuando el admin
// lo dio de alta sin email todavía (o con datos parciales) — mismos campos
// que el formulario público, editables desde el portal en vez de solo al
// crear la solicitud.
const datosSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactName: z.string().min(1).max(200),
  email: z.union([z.string().trim().email().max(255), z.literal('')]).optional(),
  phone: z.string().max(30).optional().nullable(),
  website: z.string().max(300).optional().nullable(),
  sponsorType: z.string().min(1).max(100),
  message: z.string().max(5000).optional().nullable(),
  consentAccepted: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: { sponsorId: string } }) {
  try {
    const sponsorId = params?.sponsorId;
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId }, include: { sponsorRequest: true } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }
    if (!(await allowSponsorAccess(sponsorId, sponsor.portalTokenVersion, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
    if (sponsor.status === 'APROBADO_PARA_VIDEO' || sponsor.status === 'RECHAZADO') {
      return NextResponse.json(
        { error: 'Esta solicitud ya está cerrada — escríbenos si necesitas cambiar algo.' },
        { status: 409 }
      );
    }

    const body = datosSchema.parse(await request.json());
    const newEmail = body.email || null;

    // La primera vez que el sponsor aporta su email (dato personal que el
    // alta manual sin email nunca llegó a capturar) exige el mismo
    // consentimiento RGPD que el formulario público — ver createSponsorRequestSchema
    // en /api/sponsors/route.ts.
    const isFirstTimeProvidingEmail = !sponsor.sponsorRequest.email && Boolean(newEmail);
    if (isFirstTimeProvidingEmail && body.consentAccepted !== true) {
      return NextResponse.json(
        { error: 'Debes aceptar la política de privacidad para guardar tu email' },
        { status: 400 }
      );
    }

    const updated = await prisma.sponsorRequest.update({
      where: { id: sponsor.sponsorRequestId },
      data: {
        companyName: body.companyName,
        contactName: body.contactName,
        email: newEmail,
        phone: normalizePhone(body.phone),
        website: body.website || null,
        sponsorType: body.sponsorType,
        message: body.message || null,
        consentAt: isFirstTimeProvidingEmail ? new Date() : sponsor.sponsorRequest.consentAt,
      },
      select: {
        companyName: true,
        contactName: true,
        email: true,
        phone: true,
        website: true,
        sponsorType: true,
        message: true,
      },
    });

    return NextResponse.json({ sponsorRequest: updated });
  } catch (error) {
    return handleApiError(error, 'POST /api/sponsors/portal/[sponsorId]/datos');
  }
}
