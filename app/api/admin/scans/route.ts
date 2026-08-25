export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN' && session?.user?.role !== 'TAQUILLA') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const eventId = url.searchParams.get('eventId') ?? '';
    const result = (url.searchParams.get('result') ?? '').trim();
    const q = (url.searchParams.get('q') ?? '').trim();
    const take = Math.min(Number(url.searchParams.get('take') ?? 50) || 50, 200);

    const where: Prisma.ScanLogWhereInput = {
      ...(eventId ? { eventId } : {}),
      ...(result ? { result } : {}),
      ...(q
        ? {
            OR: [
              { ticket: { holderName: { contains: q, mode: 'insensitive' } } },
              { ticket: { qrCode: { contains: q, mode: 'insensitive' } } },
              { ticket: { id: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [scans, total] = await Promise.all([
      prisma.scanLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          result: true,
          createdAt: true,
          eventId: true,
          ticketId: true,
          event: { select: { id: true, name: true } },
          ticket: {
            select: {
              id: true,
              qrCode: true,
              holderName: true,
              status: true,
              ticketType: { select: { name: true } },
            },
          },
          scanner: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.scanLog.count({ where }),
    ]);

    return NextResponse.json({ scans: scans ?? [], total, take });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/scans');
  }
}
