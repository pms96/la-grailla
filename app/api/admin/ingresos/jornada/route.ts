export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { jornadaHoy } from '@/lib/jornada';

// La jornada de negocio de AHORA (con el corte configurado). El formulario de caja la pide al abrirse: la que se calculó al cargar la página puede
// llevar horas de retraso con la pestaña abierta (H-002).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    return NextResponse.json({ jornadaHoy: await jornadaHoy() });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/ingresos/jornada');
  }
}
