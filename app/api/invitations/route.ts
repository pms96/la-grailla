export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { generateQRCode } from '@/lib/qr';
import { sendTicketsEmail } from '@/lib/tickets';
import { getBaseUrl } from '@/lib/url';
import { handleApiError } from '@/lib/api-error';

class InvitationRejectedError extends Error {}

const createInvitationSchema = z.object({
  eventId: z.string().min(1),
  listId: z.string().optional().nullable(),
  guestName: z.string().min(1),
  guestEmail: z.string().email().optional().nullable().or(z.literal('')),
  notes: z.string().optional().nullable(),
  sendEmail: z.boolean().optional(),
  quantity: z.union([z.number(), z.string()]).optional(),
});

async function requireStaff() {
  const session = await getServerSession(authOptions);
  const role = session?.user?.role ?? '';
  if (!session?.user || !['ADMIN', 'TAQUILLA'].includes(role)) return null;
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

    const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

    let emailResult: Awaited<ReturnType<typeof sendTicketsEmail>> | null = null;
    if (sendEmail && guestEmail) {
      emailResult = await sendTicketsEmail(created.order.id, true, getBaseUrl(request));
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

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (invitation.orderId) {
        // Si alguna entrada ya había sido escaneada (USED), al anularla hay que
        // descontarla del aforo físico (currentCount), o quedaría gente "dentro"
        // que ya no tiene entrada válida.
        const usedCount = await tx.ticket.count({ where: { orderId: invitation.orderId, status: 'USED' } });
        await tx.ticket.updateMany({ where: { orderId: invitation.orderId }, data: { status: 'CANCELLED' } });
        await tx.order.update({ where: { id: invitation.orderId }, data: { status: 'CANCELLED' } });
        if (usedCount > 0) {
          await tx.event.update({ where: { id: invitation.eventId }, data: { currentCount: { decrement: usedCount } } });
        }
      }
      await tx.invitation.delete({ where: { id } });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/invitations');
  }
}
