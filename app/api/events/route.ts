export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { EventStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { isAdminSessionFor } from '@/lib/access-token';
import { toPublicEvent } from '@/lib/public-event';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    // Los borradores son solo del ADMIN: antes cualquiera podía pedir ?status=DRAFT y ver eventos sin publicar.
    if (status === 'DRAFT' && !(await isAdminSessionFor('entradas'))) {
      return NextResponse.json([]);
    }

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

    return NextResponse.json((events ?? []).map(toPublicEvent));
  } catch (error) {
    return handleApiError(error, 'GET /api/events');
  }
}
