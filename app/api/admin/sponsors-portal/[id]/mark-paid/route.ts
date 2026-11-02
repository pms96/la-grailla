export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getConfig, hasConfigRow } from '@/lib/config';
import { findSponsorTier, parseSponsorTiers } from '@/lib/sponsor-tiers';
import { actorFromSession, diffFields, recordAdminAudit } from '@/lib/admin-audit';
import { MAX_IMPORTE } from '@/lib/contabilidad/validation';
import { seasonLinkEnabled } from '@/lib/modules/season-link';
import { checkTemporadaAbiertaTx } from '@/lib/contabilidad/control';

const PAYMENT_AUDIT_FIELDS = ['isPaid', 'isCollaboration', 'paidAmount'] as const;

// `amount` = lo realmente cobrado (con IVA si lo lleva). Sin él se toma la tarifa del tipo de patrocinio, pero solo si hay tarifa configurada y mayor que 0 (H-134).
const bodySchema = z.object({ mode: z.enum(['unpaid', 'paid', 'collaboration']), amount: z.number().finite().positive().max(MAX_IMPORTE).optional() });

// Marcar/desmarcar el pago no bloquea ni exige ningún estado del pipeline —
// el admin puede generar/aprobar el vídeo igual esté pagado o no (eso solo
// condiciona lo que ve el SPONSOR en su portal, ver GET
// /api/sponsors/portal/[sponsorId]). El importe se toma del precio del tipo
// de patrocinio asignado EN ESTE MOMENTO — si el precio del tipo cambia
// después en /admin/configuracion, el importe ya registrado no se recalcula —
// salvo que el admin teclee el importe realmente cobrado (`amount`), que manda
// sobre la tarifa: lo pactado o cobrado con IVA no tiene por qué ser la tarifa.
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
      // Sin tipos guardados en Configuración NO valen los de fábrica (30/50/75 €): son marcadores de posición, y un cliente nuevo registraría ingresos que no ha
      // cobrado (H-134). Sin tarifa conocida, el importe hay que teclearlo.
      const tier = (await hasConfigRow('sponsor_tiers'))
        ? findSponsorTier(parseSponsorTiers(await getConfig('sponsor_tiers')), sponsor.sponsorRequest.sponsorType)
        : null;
      if (!tier && body.amount === undefined) {
        return NextResponse.json(
          { error: 'Asigna primero el tipo de patrocinio, o indica el importe cobrado, para saber qué registrar', code: 'importe_requerido' },
          { status: 400 }
        );
      }
      const paidAmount = body.amount ?? tier?.priceAmount ?? 0;
      // Un tipo sin importe (priceAmount 0) dejaba el patrocinio «Pagado» con 0 €. Una colaboración en especie sí puede no tener valor estimado.
      if (body.mode === 'paid' && !(paidAmount > 0)) {
        return NextResponse.json({ error: 'Este tipo de patrocinio no tiene importe: indica el importe cobrado', code: 'importe_requerido' }, { status: 400 });
      }
      // El ingreso de un patrocinio cuenta en la temporada de su solicitud; sin ella no cuenta en ninguna parte. (Sin Contabilidad no hay temporadas que asignar.)
      if (body.mode === 'paid' && seasonLinkEnabled() && !sponsor.sponsorRequest.temporadaId) {
        return NextResponse.json(
          { error: 'Asigna el patrocinio a una temporada antes de marcarlo como pagado: sin ella el ingreso no cuenta en ninguna parte', code: 'temporada_requerida' },
          { status: 400 }
        );
      }
      data = { isPaid: true, isCollaboration: body.mode === 'collaboration', paidAmount, paidAt: new Date() };
    }

    // H-018/H-021: marcar (o desmarcar) un patrocinio como pagado mueve el ingreso de la temporada: queda quién, cuándo y el importe, en la misma transacción.
    // H-184: el ingreso cuenta en la temporada de la solicitud, y una temporada CERRADA no admite cambios de libros (423, igual que gastos e ingresos). Se comprueba DENTRO de la
    // transacción y con la fila bloqueada (H-014), también al desmarcar: quitar un cobro de unos libros presentados cambia el margen igual que añadirlo.
    const temporadaId = seasonLinkEnabled() ? sponsor.sponsorRequest.temporadaId : null;
    const outcome = await prisma.$transaction(async (tx) => {
      if (temporadaId) {
        const open = await checkTemporadaAbiertaTx(tx, temporadaId);
        if (!open.ok) return NextResponse.json({ error: open.error, code: open.code }, { status: open.status });
      }
      const saved = await tx.sponsor.update({ where: { id: sponsorId }, data });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'sponsor.mark_paid',
        targetType: 'Sponsor',
        targetId: sponsorId,
        meta: { mode: body.mode, paidAmount: saved.paidAmount, companyName: sponsor.sponsorRequest.companyName, cambios: diffFields(sponsor, saved, PAYMENT_AUDIT_FIELDS) },
      });
      return saved;
    });
    return outcome instanceof NextResponse ? outcome : NextResponse.json(outcome);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/mark-paid');
  }
}
