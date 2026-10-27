export const dynamic = 'force-dynamic';
// Recorre las sesiones de la pasarela (hasta 10 páginas) y contrasta con la BD: por debajo de este plazo con el presupuesto propio de abajo (30 s + el último envío + el aviso).
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/cron-auth';
import { handleApiError } from '@/lib/api-error';
import { runGatewayReconciliation } from '@/lib/reconciliation/gateway';

/**
 * Conciliación diaria pasarela → BD (OB-11, alerta nº 1: «cobro sin pedido»). Solo lectura. La dispara el panel una vez al día por cliente
 * (`reconcile-gateway` en apps/control-panel/lib/services/crons.ts). Ver lib/reconciliation/gateway.ts.
 * 502 solo si NO pudo mirar ninguna cuenta (credencial inválida, pasarela caída): así el disparador lo cuenta como fallo y lo reintenta con backoff.
 * Que haya cobros sin pedido NO es un fallo de la tarea (la tarea funcionó): es un hallazgo, y sale por el aviso y por el bloque `ops` del health.
 */
export async function GET(request: Request) {
  try {
    const auth = await authorizeCron(request);
    if (auth === 'not_configured') {
      console.error('[GET /api/cron/reconcile-gateway] Falta el secreto de cron (CRON_SECRET o PLATFORM_CRON_MASTER)');
      return NextResponse.json({ error: 'Cron no configurado' }, { status: 500 });
    }
    if (auth === 'unauthorized') return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const { summary, samples } = await runGatewayReconciliation({ deadline: Date.now() + 30_000 });
    const failed = summary.errors > 0 && summary.checked === 0;
    return NextResponse.json({ ...summary, samples }, { status: failed ? 502 : 200 });
  } catch (error) {
    return handleApiError(error, 'GET /api/cron/reconcile-gateway');
  }
}
