export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { adminLacksModule } from '@/lib/modules/access';
import { authOptions } from '@/lib/auth';
import { generateQRCode } from '@/lib/qr';
import { sendOrderEmail, sendResultResponse } from '@/lib/order-email';
import { getBaseUrl } from '@/lib/url';
import { handleApiError } from '@/lib/api-error';
import { actorFromSession, recordAdminAudit } from '@/lib/admin-audit';

class InvitationRejectedError extends Error {}
class InvitationHasEntriesError extends Error {}

const createInvitationSchema = z.object({
  eventId: z.string().min(1),
  listId: z.string().optional().nullable(),
  guestName: z.string().min(1).max(100),
  guestEmail: z.string().email().optional().nullable().or(z.literal('')),
  notes: z.string().optional().nullable(),
  sendEmail: z.boolean().optional(),
  quantity: z.union([z.number(), z.string()]).optional(),
});

async function requireStaff() {
  const session = await getServerSession(authOptions);
  const role = session?.user?.role ?? '';
  if (!session?.user || !['ADMIN', 'TAQUILLA'].includes(role)) return null;
  if (adminLacksModule(session.user, 'entradas')) return null; // rol restringido sin Entradas (el middleware ya responde 403; esto es la red de seguridad)
  return session;
}

export async function GET(request: Request) {
  const session = await requireStaff();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get('eventId');
  const listId = searchParams.get('listId');

  const where: Prisma.InvitationWhereInput = {};
  if (eventId) where.eventId = eventId;
  if (listId) where.listId = listId;
  // H-060: la taquilla (RRPP) solo ve SUS invitaciones: esta respuesta lleva el email de cada invitado.
  if (session.user?.role !== 'ADMIN') where.createdById = session.user?.id ?? '__sin_usuario__';

  const invitations = await prisma.invitation.findMany({
    where,
    include: {
      list: { select: { id: true, name: true } },
      event: { select: { id: true, name: true } },
      order: { select: { id: true, emailSentAt: true, tickets: { select: { id: true, status: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json(invitations ?? []);
}

export async function POST(request: Request) {
  const session = await requireStaff();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  try {
    const body = createInvitationSchema.parse(await request.json());
    const { eventId, listId, guestName, guestEmail, notes, sendEmail } = body;
    const quantity = Math.max(1, Math.min(20, parseInt(String(body?.quantity ?? 1), 10) || 1));

    if (!eventId || !guestName) {
      return NextResponse.json({ error: 'Faltan datos de la invitacion' }, { status: 400 });
    }

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
    // H-060: una taquilla solo añade invitados a SUS listas.
    if (listId) {
      const list = await prisma.guestList.findUnique({ where: { id: listId }, select: { ownerId: true, eventId: true } });
      if (!list || list.eventId !== eventId) return NextResponse.json({ error: 'Lista no encontrada' }, { status: 404 });
      if (session.user?.role !== 'ADMIN' && list.ownerId !== session.user?.id) {
        return NextResponse.json({ error: 'Solo puedes añadir invitados a tus propias listas.', code: 'not_owner' }, { status: 403 });
      }
    }
    // H-080: un evento cancelado o terminado no admite invitaciones (se emitía el QR y se enviaba el email). Un borrador sí: lista VIP antes de anunciarlo.
    if (event.status === 'CANCELLED' || event.status === 'FINISHED') {
      return NextResponse.json(
        { error: event.status === 'CANCELLED' ? 'El evento está cancelado: no se pueden crear invitaciones.' : 'El evento ya ha terminado: no se pueden crear invitaciones.', code: 'event_not_open' },
        { status: 409 }
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      // Mismo criterio que app/api/orders/route.ts y taquilla/sale: serializa
      // por evento para que dos invitaciones (o una invitación y una compra)
      // simultáneas no lean el aforo antes de que la otra lo actualice y
      // acaben, entre las dos, sobrepasando el máximo.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;

      const issuedCount = await tx.ticket.count({
        where: { eventId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      });
      if (issuedCount + quantity > (event.maxCapacity ?? 0)) {
        throw new InvitationRejectedError('Aforo completo');
      }

      const order = await tx.order.create({
        data: {
          eventId,
          buyerName: guestName,
          buyerLastName: '',
          buyerEmail: guestEmail || 'invitacion@lagrailla.local',
          totalAmount: 0,
          commission: 0,
          paymentMethod: 'FREE',
          status: 'COMPLETED',
          channel: 'INVITACION',
          soldById: session.user?.id ?? null,
        },
      });

      for (let i = 0; i < quantity; i++) {
        await tx.ticket.create({
          data: {
            orderId: order.id,
            eventId,
            qrCode: generateQRCode(),
            holderName: guestName,
            status: 'VALID',
          },
        });
      }

      const invitation = await tx.invitation.create({
        data: {
          eventId,
          listId: listId || null,
          guestName,
          guestEmail: guestEmail || null,
          quantity,
          notes: notes || null,
          createdById: session.user?.id ?? null,
          orderId: order.id,
        },
      });

      return { order, invitation };
    }).catch((error) => {
      if (error instanceof InvitationRejectedError) return error;
      throw error;
    });

    if (created instanceof InvitationRejectedError) {
      return NextResponse.json({ error: created.message }, { status: 400 });
    }

    // Por el único punto de envío (concesión atómica, rastro del intento). La invitación va a quien el personal ha elegido, así que se salta el backoff.
    let emailResult: { success: boolean; status: string; error?: string } | null = null;
    if (sendEmail && guestEmail) {
      emailResult = sendResultResponse(await sendOrderEmail('entradas', created.order.id, { baseUrl: getBaseUrl(request), mode: 'manual', resend: true }), { detail: true }).body;
    }

    return NextResponse.json({ success: true, invitation: created.invitation, orderId: created.order.id, emailResult });
  } catch (error) {
    return handleApiError(error, 'POST /api/invitations');
  }
}

export async function DELETE(request: Request) {
  const session = await requireStaff();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Falta el id' }, { status: 400 });

  try {
    const invitation = await prisma.invitation.findUnique({ where: { id } });
    if (!invitation) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
    // H-060: la taquilla solo borra las suyas; el ADMIN, cualquiera.
    if (session.user?.role !== 'ADMIN' && invitation.createdById !== session.user?.id) {
      return NextResponse.json({ error: 'Solo puedes borrar tus propias invitaciones.', code: 'not_owner' }, { status: 403 });
    }

    await prisma.$transaction(async (tx) => {
      if (invitation.orderId) {
        // H-060: una entrada ya USADA no se anula (antes se cancelaba y se descontaba del aforo: quedaba gente «dentro» sin entrada y sin rastro de quién
        // la admitió). Se anula lo que no ha entrado y, si entretanto se escaneó alguna, se deshace todo. Para quitar una entrada usada hay que cancelarla a mano.
        await tx.ticket.updateMany({ where: { orderId: invitation.orderId, status: { not: 'USED' } }, data: { status: 'CANCELLED' } });
        if ((await tx.ticket.count({ where: { orderId: invitation.orderId, status: 'USED' } })) > 0) throw new InvitationHasEntriesError();
        await tx.order.update({ where: { id: invitation.orderId }, data: { status: 'CANCELLED' } });
      }
      await tx.invitation.delete({ where: { id } });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'invitation.delete',
        targetType: 'Invitation',
        targetId: id,
        meta: { eventId: invitation.eventId, listId: invitation.listId, quantity: invitation.quantity, createdById: invitation.createdById },
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof InvitationHasEntriesError) {
      return NextResponse.json({ error: 'Esta invitación tiene entradas que ya han entrado: no se puede borrar.', code: 'invitation_has_entries' }, { status: 409 });
    }
    return handleApiError(error, 'DELETE /api/invitations');
  }
}
