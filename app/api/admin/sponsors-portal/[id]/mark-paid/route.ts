export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getConfig } from '@/lib/config';
import { findSponsorTier, parseSponsorTiers } from '@/lib/sponsor-tiers';
import { actorFromSession, diffFields, recordAdminAudit } from '@/lib/admin-audit';

const PAYMENT_AUDIT_FIELDS = ['isPaid', 'isCollaboration', 'paidAmount'] as const;

const bodySchema = z.object({ mode: z.enum(['unpaid', 'paid', 'collaboration']) });

// Marcar/desmarcar el pago no bloquea ni exige ningún estado del pipeline —
// el admin puede generar/aprobar el vídeo igual esté pagado o no (eso solo
// condiciona lo que ve el SPONSOR en su portal, ver GET
// /api/sponsors/portal/[sponsorId]). El importe se toma del precio del tipo
// de patrocinio asignado EN ESTE MOMENTO — si el precio del tipo cambia
// después en /admin/configuracion, el importe ya registrado no se recalcula.
//
// 'collaboration' es el mismo desbloqueo que 'paid' (isPaid: true — el
// sponsor no tiene ningún pago pendiente) pero marcado con isCollaboration
// para que /admin/gastos lo excluya de ingresosPatrocinio: fue una
// aportación en especie, no dinero real cobrado.
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsorId = params?.id;
    const body = bodySchema.parse(await request.json());

    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId }, include: { sponsorRequest: true } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }

    let data: { isPaid: boolean; isCollaboration: boolean; paidAmount: number | null; paidAt: Date | null };
    if (body.mode === 'unpaid') {
      data = { isPaid: false, isCollaboration: false, paidAmount: null, paidAt: null };
    } else {
      const tiers = parseSponsorTiers(await getConfig('sponsor_tiers'));
      const tier = findSponsorTier(tiers, sponsor.sponsorRequest.sponsorType);
      if (!tier) {
        return NextResponse.json(
          { error: 'Asigna primero el tipo de patrocinio para saber qué importe registrar' },
          { status: 400 }
        );
      }
      data = { isPaid: true, isCollaboration: body.mode === 'collaboration', paidAmount: tier.priceAmount, paidAt: new Date() };
    }

    // H-018/H-021: marcar (o desmarcar) un patrocinio como pagado mueve el ingreso de la temporada: queda quién, cuándo y el importe, en la misma transacción.
    const updated = await prisma.$transaction(async (tx) => {
      const saved = await tx.sponsor.update({ where: { id: sponsorId }, data });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'sponsor.mark_paid',
        targetType: 'Sponsor',
        targetId: sponsorId,
        meta: { mode: body.mode, paidAmount: saved.paidAmount, companyName: sponsor.sponsorRequest.companyName, cambios: diffFields(sponsor, saved, PAYMENT_AUDIT_FIELDS) },
      });
      return saved;
    });
    return NextResponse.json(updated);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/mark-paid');
  }
}
