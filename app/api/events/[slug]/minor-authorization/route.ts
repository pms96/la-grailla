export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { buildMinorAuthorizationPdf } from '@/lib/minor-authorization-pdf';

export async function GET(
  request: Request,
  { params }: { params: { slug: string } }
) {
  try {
    const event = await prisma.event.findUnique({ where: { slug: params?.slug } });

    if (!event || !event.minorAuthorizationEnabled) {
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
