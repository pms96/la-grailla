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
    const sponsor = await prisma.sponsor.update({
      where: { id: params?.id },
      data: { status: 'RECHAZADO' },
    });
    return NextResponse.json(sponsor);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/reject');
  }
}
