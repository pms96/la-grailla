export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cleanupAllStaleEntries } from '@/lib/waiting-room';
import { handleApiError } from '@/lib/api-error';
import { authorizeCron } from '@/lib/cron-auth';

// La limpieza normal (lib/waiting-room.ts) es oportunista: solo se dispara
// con un 2% de probabilidad cuando alguien llama a join/status de ESE
// evento en concreto. Para un evento ya pasado, o con tráfico bajo, nadie
// vuelve a tocar su cola y esas filas EXPIRED/COMPLETED se acumulan sin
// límite. Este cron es la red de seguridad, igual que
// /api/cron/reconcile-payments para los pedidos pendientes.
export async function GET(request: Request) {
  try {
    const auth = await authorizeCron(request);
    if (auth === 'not_configured') {
      console.error('[GET /api/cron/cleanup-waiting-room] Falta el secreto de cron (CRON_SECRET o PLATFORM_CRON_MASTER)');
      return NextResponse.json({ error: 'Cron no configurado' }, { status: 500 });
    }
    if (auth === 'unauthorized') {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const deleted = await cleanupAllStaleEntries();

    return NextResponse.json({ deleted });
  } catch (error) {
    return handleApiError(error, 'GET /api/cron/cleanup-waiting-room');
  }
}
