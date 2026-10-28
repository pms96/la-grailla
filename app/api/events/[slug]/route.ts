export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { isAdminSessionFor } from '@/lib/access-token';
import { toPublicEvent } from '@/lib/public-event';

export async function GET(request: Request, props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  try {
    const event = await prisma.event.findUnique({
      where: { slug: params?.slug },
      include: {
        ticketTypes: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    // Un borrador solo existe para el ADMIN; para el resto es como si no estuviera.
    if (!event || (event.status === 'DRAFT' && !(await isAdminSessionFor('entradas')))) {
      return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
    }

    return NextResponse.json(toPublicEvent(event));
  } catch (error) {
    return handleApiError(error, 'GET /api/events/[slug]');
  }
}
