export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cleanupAllStaleEntries } from '@/lib/waiting-room';
import { handleApiError } from '@/lib/api-error';

// La limpieza normal (lib/waiting-room.ts) es oportunista: solo se dispara
// con un 2% de probabilidad cuando alguien llama a join/status de ESE
// evento en concreto. Para un evento ya pasado, o con tráfico bajo, nadie
// vuelve a tocar su cola y esas filas EXPIRED/COMPLETED se acumulan sin
// límite. Este cron es la red de seguridad, igual que
// /api/cron/reconcile-payments para los pedidos pendientes.
export async function GET(request: Request) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      console.error('[GET /api/cron/cleanup-waiting-room] Falta CRON_SECRET en las variables de entorno');
      return NextResponse.json({ error: 'Cron no configurado' }, { status: 500 });
    }
    if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const deleted = await cleanupAllStaleEntries();

    return NextResponse.json({ deleted });
  } catch (error) {
    return handleApiError(error, 'GET /api/cron/cleanup-waiting-room');
  }
}
