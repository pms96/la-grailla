export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsors = await prisma.sponsorRequest.findMany({ orderBy: { createdAt: 'desc' } });
    return NextResponse.json(sponsors ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/sponsors');
  }
}
