export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import type { Prisma } from '@prisma/client';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const status = new URL(request.url).searchParams.get('status');
    const where: Prisma.SponsorWhereInput = status ? { status: status as never } : {};

    const sponsors = await prisma.sponsor.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { sponsorRequest: true, currentAsset: true, videoPrompt: true },
    });

    return NextResponse.json(sponsors ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/sponsors-portal');
  }
}
