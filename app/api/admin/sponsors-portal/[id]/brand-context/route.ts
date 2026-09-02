export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const brandContextSchema = z.object({ brandContext: z.string() });

// El admin investiga la marca (su web, redes, a qué se dedica) y guarda aquí
// un resumen — sin esto la IA solo veía el logo + respuestas cortas del
// sponsor y todos los vídeos salían con la misma estructura genérica.
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { brandContext } = brandContextSchema.parse(await request.json());
    const sponsor = await prisma.sponsor.update({
      where: { id: params?.id },
      data: { brandContext: brandContext || null },
    });
    return NextResponse.json(sponsor);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/sponsors-portal/[id]/brand-context');
  }
}
