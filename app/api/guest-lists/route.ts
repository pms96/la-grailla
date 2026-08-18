export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

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
  return session;
}

export async function GET(request: Request) {
  const session = await requireStaff();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get('eventId');

  const lists = await prisma.guestList.findMany({
    where: eventId ? { eventId } : undefined,
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
    await prisma.guestList.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/guest-lists');
  }
}
