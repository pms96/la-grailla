export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

// El admin confirma explícitamente que ha revisado el logo y la descripción
// antes de gastar uno de los 3 intentos de generación disponibles.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const result = await prisma.sponsor.updateMany({
      where: { id: params?.id, status: 'PENDIENTE_REVISION' },
      data: { status: 'LISTO_PARA_GENERAR' },
    });
    if (result.count === 0) {
      return NextResponse.json(
        { error: 'El sponsor no está en estado "pendiente de revisión"' },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/ready');
  }
}
