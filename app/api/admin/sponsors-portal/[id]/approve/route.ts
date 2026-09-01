export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsorId = params?.id;
    const prompt = await prisma.sponsorVideoPrompt.findUnique({ where: { sponsorId } });
    if (!prompt) {
      return NextResponse.json({ error: 'Este sponsor todavía no tiene un prompt generado' }, { status: 400 });
    }

    await prisma.$transaction([
      prisma.sponsorVideoPrompt.update({
        where: { sponsorId },
        data: { approvedAt: new Date(), approvedById: session.user?.id },
      }),
      prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'APROBADO_PARA_VIDEO' } }),
    ]);

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/approve');
  }
}
