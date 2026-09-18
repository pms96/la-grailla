export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getConfig } from '@/lib/config';
import { findSponsorTier, parseSponsorTiers } from '@/lib/sponsor-tiers';

const bodySchema = z.object({ paid: z.boolean() });

// Marcar/desmarcar el pago no bloquea ni exige ningún estado del pipeline —
// el admin puede generar/aprobar el vídeo igual esté pagado o no (eso solo
// condiciona lo que ve el SPONSOR en su portal, ver GET
// /api/sponsors/portal/[sponsorId]). El importe se toma del precio del tipo
// de patrocinio asignado EN ESTE MOMENTO — si el precio del tipo cambia
// después en /admin/configuracion, el importe ya registrado no se recalcula.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsorId = params?.id;
    const body = bodySchema.parse(await request.json());

    if (!body.paid) {
      const updated = await prisma.sponsor.update({
        where: { id: sponsorId },
        data: { isPaid: false, paidAmount: null, paidAt: null },
      });
      return NextResponse.json(updated);
    }

    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId }, include: { sponsorRequest: true } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }
    const tiers = parseSponsorTiers(await getConfig('sponsor_tiers'));
    const tier = findSponsorTier(tiers, sponsor.sponsorRequest.sponsorType);
    if (!tier) {
      return NextResponse.json(
        { error: 'Asigna primero el tipo de patrocinio para saber qué importe registrar' },
        { status: 400 }
      );
    }

    const updated = await prisma.sponsor.update({
      where: { id: sponsorId },
      data: { isPaid: true, paidAmount: tier.priceAmount, paidAt: new Date() },
    });
    return NextResponse.json(updated);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/mark-paid');
  }
}
