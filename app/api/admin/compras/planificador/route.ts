export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getPlanificadorData } from '@/lib/compras/planificador-data';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const temporadaId = searchParams.get('temporadaId');
    if (!temporadaId) {
      return NextResponse.json({ error: 'Falta temporadaId' }, { status: 400 });
    }

    const data = await getPlanificadorData(temporadaId);
    if (!data) {
      return NextResponse.json({ error: 'Temporada no encontrada' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/planificador');
  }
}
