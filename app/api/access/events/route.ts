export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { adminLacksModule } from '@/lib/modules/access';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

/* Lista de eventos de la PUERTA (`/acceso`): solo lectura y solo staff. Vive bajo `/api/access` para quedar en la allowlist «nunca
 * bloqueable» (lib/modules/registry.ts): en la puerta hay que seguir validando entradas ya vendidas aunque la licencia esté en BLOCKED o
 * el módulo apagado, y de aquí saca el escáner qué evento escanear. Por eso devuelve SOLO lo que el escáner necesita (nada de tipos de
 * entrada, precios ni compradores) y no se reutiliza `GET /api/events`, que es la API pública de venta y sí se corta. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN' && session?.user?.role !== 'TAQUILLA') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  if (adminLacksModule(session.user, 'entradas')) {
    return NextResponse.json({ error: 'Sin permiso para este módulo' }, { status: 403 });
  }
  try {
    const events = await prisma.event.findMany({
      // Publicados, y los terminados HACE POCO: el personal puede cerrar el evento antes que la puerta, y el escáner exige elegir evento (sin él no
      // valida nada), así que un evento FINISHED de esta noche tiene que seguir en la lista.
      where: { OR: [{ status: 'PUBLISHED' }, { status: 'FINISHED', date: { gte: new Date(Date.now() - 3 * 24 * 60 * 60_000) } }] },
      select: { id: true, name: true, date: true, status: true, currentCount: true, maxCapacity: true },
      orderBy: { date: 'asc' },
    });
    return NextResponse.json(events);
  } catch (error) {
    return handleApiError(error, 'GET /api/access/events');
  }
}
