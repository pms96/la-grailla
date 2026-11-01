export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { buildMinorAuthorizationPdf } from '@/lib/minor-authorization-pdf';
import { isEventPageVisible } from '@/lib/public-event';
import { isAdminSessionFor } from '@/lib/access-token';

export async function GET(request: Request, props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  try {
    const event = await prisma.event.findUnique({ where: { slug: params?.slug } });

    if (!event || !event.minorAuthorizationEnabled) {
      return NextResponse.json({ error: 'No disponible' }, { status: 404 });
    }
    // H-059: el PDF lleva el nombre, fecha y lugar del evento; en borrador solo lo descarga quien gestiona los eventos.
    if (!isEventPageVisible(event.status, event.status === 'DRAFT' && (await isAdminSessionFor('entradas')))) {
      return NextResponse.json({ error: 'No disponible' }, { status: 404 });
    }

    const pdfBytes = await buildMinorAuthorizationPdf(event);

    return new NextResponse(Buffer.from(pdfBytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="autorizacion-menores-${event.slug}.pdf"`,
      },
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/events/[slug]/minor-authorization');
  }
}
