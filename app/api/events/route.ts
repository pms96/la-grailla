export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { EventStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    const events = await prisma.event.findMany({
      where: status ? { status: status as EventStatus } : { status: { not: 'DRAFT' } },
      include: {
        ticketTypes: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { date: 'asc' },
    });

    return NextResponse.json(events ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/events');
  }
}
