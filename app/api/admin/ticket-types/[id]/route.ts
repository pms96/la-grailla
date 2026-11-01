export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { MIN_ONLINE_PAYMENT, toCents } from '@/lib/pricing';
import { actorFromSession, diffFields, recordAdminAudit } from '@/lib/admin-audit';

const TICKET_TYPE_AUDIT_FIELDS = ['name', 'price', 'phase', 'phaseName', 'maxQuantity', 'isActive'] as const;

const updateTicketTypeSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  price: z.coerce.number().min(0).optional(),
  phase: z.coerce.number().optional(),
  phaseName: z.string().optional().nullable(),
  maxQuantity: z.coerce.number().min(0).optional(),
  sortOrder: z.coerce.number().optional(),
  isActive: z.boolean().optional(),
});

export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = updateTicketTypeSchema.parse(await request.json());
    // 0 (gratuita) o al menos 0,50 €: Stripe no admite cobros menores y el comprador vería un error al pagar. Solo se exige si el precio CAMBIA: editar
    // otro campo de un tipo antiguo con un precio menor (el formulario reenvía el precio) no debe fallar por esto.
    if (body.price !== undefined && body.price > 0 && body.price < MIN_ONLINE_PAYMENT) {
      const current = await prisma.ticketType.findUnique({ where: { id: params?.id }, select: { price: true } });
      if (current && toCents(Number(current.price)) !== toCents(body.price)) {
        return NextResponse.json({ error: 'El precio debe ser 0 (gratuita) o de al menos 0,50 €' }, { status: 400 });
      }
    }
    const before = await prisma.ticketType.findUnique({ where: { id: params?.id } });
    if (!before) return NextResponse.json({ error: 'Tipo de entrada no encontrado' }, { status: 404 });
    // H-018/H-021: el precio cambia con su rastro (de → a) en la misma transacción.
    const tt = await prisma.$transaction(async (tx) => {
      const updated = await tx.ticketType.update({
        where: { id: params?.id },
        data: {
          name: body?.name,
          description: body?.description,
          price: body?.price,
          phase: body?.phase,
          phaseName: body?.phaseName,
          maxQuantity: body?.maxQuantity,
          sortOrder: body?.sortOrder,
          isActive: body?.isActive,
        },
      });
      const cambios = diffFields(before, updated, TICKET_TYPE_AUDIT_FIELDS);
      if (Object.keys(cambios).length > 0) {
        await recordAdminAudit(tx, actorFromSession(session), request, {
          action: 'event.ticket_type_update',
          targetType: 'TicketType',
          targetId: updated.id,
          meta: { eventId: updated.eventId, name: updated.name, cambios },
        });
      }
      return updated;
    });
    return NextResponse.json(tt);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/ticket-types/[id]');
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    // Borrar un tipo con entradas ya emitidas reventaría por la FK de
    // Ticket → TicketType con un error crudo de Prisma. Si ya se ha vendido
    // algo, se desactiva (isActive:false, igual que Product) en vez de
    // borrar de verdad.
    const soldCount = await prisma.ticket.count({ where: { ticketTypeId: params?.id } });
    if (soldCount > 0) {
      return NextResponse.json(
        { error: 'No se puede eliminar: ya hay entradas vendidas de este tipo. Desactívalo en su lugar.' },
        { status: 400 }
      );
    }
    const before = await prisma.ticketType.findUnique({ where: { id: params?.id } });
    if (!before) return NextResponse.json({ error: 'Tipo de entrada no encontrado' }, { status: 404 });
    await prisma.$transaction(async (tx) => {
      await tx.ticketType.delete({ where: { id: params?.id } });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'event.ticket_type_delete',
        targetType: 'TicketType',
        targetId: before.id,
        meta: { eventId: before.eventId, name: before.name, price: before.price, maxQuantity: before.maxQuantity },
      });
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/ticket-types/[id]');
  }
}
