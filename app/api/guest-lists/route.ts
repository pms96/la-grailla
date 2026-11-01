export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { adminLacksModule } from '@/lib/modules/access';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { actorFromSession, recordAdminAudit } from '@/lib/admin-audit';

const createGuestListSchema = z.object({
  eventId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  ownerName: z.string().optional().nullable(),
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

  // H-060: la taquilla (RRPP) solo ve SUS listas (con sus invitados, que llevan email); el ADMIN, todas.
  const where = { ...(eventId ? { eventId } : {}), ...(session.user?.role !== 'ADMIN' ? { ownerId: session.user?.id ?? '__sin_usuario__' } : {}) };
  const lists = await prisma.guestList.findMany({
    where,
    include: { invitations: true, event: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json(lists ?? []);
}

export async function POST(request: Request) {
  const session = await requireStaff();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  try {
    const body = createGuestListSchema.parse(await request.json());
    const list = await prisma.guestList.create({
      data: {
        eventId: body.eventId,
        name: body.name,
        description: body?.description ?? null,
        ownerId: session.user?.id ?? null,
        ownerName: body?.ownerName ?? session.user?.name ?? null,
      },
    });
    return NextResponse.json(list);
  } catch (error) {
    return handleApiError(error, 'POST /api/guest-lists');
  }
}

export async function DELETE(request: Request) {
  const session = await requireStaff();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Falta el id' }, { status: 400 });

  try {
    const list = await prisma.guestList.findUnique({ where: { id }, include: { _count: { select: { invitations: true } } } });
    if (!list) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
    // H-060: la taquilla solo borra las suyas; el ADMIN, cualquiera. Las invitaciones de la lista no se borran: quedan sin lista.
    if (session.user?.role !== 'ADMIN' && list.ownerId !== session.user?.id) {
      return NextResponse.json({ error: 'Solo puedes borrar tus propias listas.', code: 'not_owner' }, { status: 403 });
    }
    await prisma.$transaction(async (tx) => {
      await tx.guestList.delete({ where: { id } });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'invitation.list_delete',
        targetType: 'GuestList',
        targetId: id,
        meta: { eventId: list.eventId, invitations: list._count.invitations, ownerId: list.ownerId },
      });
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/guest-lists');
  }
}
