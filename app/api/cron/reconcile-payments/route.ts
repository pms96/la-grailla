export const dynamic = 'force-dynamic';
// Tiempo máximo de la función. Cada pedido puede costar hasta tres llamadas a la pasarela (verificar, cerrar, verificar) de hasta 15 s cada una,
// y una pasada examina hasta 200: con el tiempo por defecto de la plataforma se cortaba a mitad. Ver también TIME_BUDGET_MS.
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { settleUnpaidOrder, type SettleKind, type SettleOrder } from '@/lib/reconciliation/settle';
import { STALE_ORDER_SAFETY_NET_MS } from '@/lib/checkout-hold';
import { handleApiError } from '@/lib/api-error';
import { authorizeCron } from '@/lib/cron-auth';
import { currentTenant } from '@/lib/tenant/context';
import { captureOpsError } from '@/lib/observability/capture';
import { emailSweepBudgetMs, sweepUnsentOrderEmails } from '@/lib/order-email';
import { runEventNoticeSweep, type EventNoticeSweepResult } from '@/lib/event-cancellation';
import { sweepShopNewOrderNotices } from '@/lib/shop/shop-notices';
import { repairRefundedOrders } from '@/lib/reconciliation/gateway-refund';
import { getFallbackBaseUrl } from '@/lib/url';
import { OPS_RECONCILE_KEY, type ReconcileSummary } from '@/lib/ops-health';

// Solo Stripe tiene webhook (app/api/webhooks/stripe) — SumUp no, así que un
// pedido pagado con SumUp solo se confirma hoy si el comprador vuelve a
// /confirmacion/[orderId] (ver GET de esa ruta). Si cierra la pestaña, pierde
// cobertura, o el redirect de SumUp falla, ese pedido y sus entradas se
// quedan en PENDING para siempre sin ningún mecanismo que lo reintente. Este
// cron es la red de seguridad: revisa periódicamente los pedidos pendientes
// y comprueba el estado real contra la pasarela, igual que ya hace esa
// misma ruta al vuelo.
//
// Además libera el aforo/stock de los PENDING que ya no se pueden pagar (checkout abandonado) — crítico para SumUp, que no emite evento
// de expiración como Stripe. La decisión (completar / liberar / esperar / no tocar) es de `settleUnpaidOrder`, que solo libera con la
// pasarela confirmando que el pago ya no puede llegar: un fallo al consultarla (UNKNOWN) o un cobro en curso (PROCESSING) NUNCA liberan.
const MIN_AGE_MS = 2 * 60_000; // deja margen a que el comprador siga en pleno checkout y a que se guarde el paymentId
// Pedidos que se examinan por lista y pasada. Los que tienen un pago en la pasarela son los que importan en una venta: SumUp no tiene webhook, así que
// un comprador que cierra la pestaña tras pagar solo recibe sus entradas cuando este cron lo examina (P1-13: con 50, 400 pagos esperaban 8 pasadas, 40 min).
// El presupuesto de tiempo (`timeBudgetMs`) sigue siendo el tope real: lo que no cabe queda para la siguiente pasada sin sellar. Los pedidos sin pasarela
// (red de seguridad por antigüedad) no tienen prisa y se quedan en 50. `RECONCILE_GATEWAY_BATCH` permite ajustarlo (y probarlo) sin tocar código.
const BATCH_SIZE = 50;
const DEFAULT_GATEWAY_BATCH_SIZE = 100;
const gatewayBatchSize = () => {
  const n = Math.floor(Number(process.env.RECONCILE_GATEWAY_BATCH));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : DEFAULT_GATEWAY_BATCH_SIZE;
};
// Pedidos que se atienden A LA VEZ (llamadas a la pasarela en paralelo, con tope: no se martillea la API) y presupuesto de tiempo de la pasada: pasado,
// el bucle para y el resto queda para la siguiente pasada SIN sellar (conserva su sitio en la cola justa). Por debajo de `maxDuration` con margen para
// que termine el grupo en curso y se responda. `RECONCILE_TIME_BUDGET_MS` solo existe para poder probarlo.
const CONCURRENCY = 5;
const DEFAULT_TIME_BUDGET_MS = 45_000;
const timeBudgetMs = () => {
  const n = Number(process.env.RECONCILE_TIME_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIME_BUDGET_MS;
};

/** Cliente de esta pasada, para los logs: en un proyecto compartido, un error de pago sin cliente no se puede atribuir a nadie. */
const tenantTag = () => currentTenant()?.tenantId ?? '-';

// Cola justa (M7): con `createdAt asc` a secas, 50 pedidos atascados en cabeza (pasarela caída, pago que no llega) se examinan en cada
// pasada y los nuevos no se atienden nunca. Se atiende primero lo que nunca se examinó y luego lo examinado hace más tiempo; el
// desempate por antigüedad conserva el comportamiento anterior cuando nadie se ha examinado todavía.
const FAIR_QUEUE_ORDER = [
  { reconcileCheckedAt: { sort: 'asc' as const, nulls: 'first' as const } },
  { createdAt: 'asc' as const },
];

/** Marca cada pedido examinado (también los que siguen pendientes o dan error). No toca `status`: una finalización concurrente no se pisa. */
async function stampExamined(table: 'order' | 'shopOrder', ids: string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  const data = { reconcileCheckedAt: at, reconcileAttempts: { increment: 1 } };
  const where = { id: { in: ids } };
  try {
    if (table === 'order') await prisma.order.updateMany({ where, data });
    else await prisma.shopOrder.updateMany({ where, data });
  } catch (error) {
    // Sellar es una mejora de equidad, no condición para reconciliar: si falla se sigue con la pasada.
    console.error('[GET /api/cron/reconcile-payments] No se pudo sellar la cola:', error instanceof Error ? error.message : error);
  }
}

/** Guarda cómo terminó la pasada (clave de sistema `ops_reconcile_last`, ver lib/ops-health.ts). Nunca lanza. */
async function writeReconcileSummary(summary: ReconcileSummary): Promise<void> {
  try {
    const value = JSON.stringify(summary);
    await prisma.appConfig.upsert({ where: { key: OPS_RECONCILE_KEY }, update: { value }, create: { key: OPS_RECONCILE_KEY, value, label: 'Última pasada de conciliación', group: 'sistema' } });
  } catch (error) {
    console.error(`[GET /api/cron/reconcile-payments] [cliente ${tenantTag()}] No se pudo guardar el resumen de la pasada:`, error instanceof Error ? error.message : error);
  }
}

export async function GET(request: Request) {
  try {
    const auth = await authorizeCron(request);
    if (auth === 'not_configured') {
      console.error('[GET /api/cron/reconcile-payments] Falta el secreto de cron (CRON_SECRET o PLATFORM_CRON_MASTER)');
      return NextResponse.json({ error: 'Cron no configurado' }, { status: 500 });
    }
    if (auth === 'unauthorized') {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const now = Date.now();
    const deadline = now + timeBudgetMs();
    const maxCreated = new Date(now - MIN_AGE_MS);
    const staleCreated = new Date(now - STALE_ORDER_SAFETY_NET_MS);

    // Pedidos con pago en la pasarela: se examinan SIEMPRE, sea cual sea su edad (la decisión de liberar es de settleUnpaidOrder).
    const withGateway = { status: 'PENDING' as const, paymentProvider: { notIn: ['mock'] }, paymentId: { not: null }, createdAt: { lte: maxCreated } };
    // Pedidos que nunca llegaron a la pasarela (sin paymentId o con la simulada): red de seguridad por antigüedad.
    const withoutGateway = {
      status: 'PENDING' as const,
      createdAt: { lt: staleCreated },
      OR: [{ paymentId: null }, { paymentProvider: null }, { paymentProvider: 'mock' }],
    };

    const [pendingTicketOrders, abandonedTicketOrders, pendingShopOrders, abandonedShopOrders] =
      await Promise.all([
        prisma.order.findMany({ where: withGateway, take: gatewayBatchSize(), orderBy: FAIR_QUEUE_ORDER }),
        prisma.order.findMany({ where: withoutGateway, take: BATCH_SIZE, orderBy: FAIR_QUEUE_ORDER }),
        prisma.shopOrder.findMany({ where: withGateway, take: gatewayBatchSize(), orderBy: FAIR_QUEUE_ORDER }),
        prisma.shopOrder.findMany({ where: withoutGateway, take: BATCH_SIZE, orderBy: FAIR_QUEUE_ORDER }),
      ]);

    let completed = 0;
    let released = 0;
    let stillPending = 0;
    let processing = 0;
    let unknown = 0;
    let errors = 0;
    let stuckOver24h = 0;
    const errorSamples: string[] = [];
    const noteError = (kind: SettleKind, orderId: string, reason: string) => {
      errors += 1;
      if (errorSamples.length < 5) errorSamples.push(`${kind}:${orderId}:${reason.slice(0, 160)}`);
    };

    const queue: { kind: SettleKind; table: 'order' | 'shopOrder'; order: SettleOrder }[] = [
      ...pendingTicketOrders.map((order) => ({ kind: 'entradas' as const, table: 'order' as const, order })),
      ...abandonedTicketOrders.map((order) => ({ kind: 'entradas' as const, table: 'order' as const, order })),
      ...pendingShopOrders.map((order) => ({ kind: 'tienda' as const, table: 'shopOrder' as const, order })),
      ...abandonedShopOrders.map((order) => ({ kind: 'tienda' as const, table: 'shopOrder' as const, order })),
    ];

    const settleOne = async ({ kind, order }: (typeof queue)[number]) => {
      try {
        // El email del pedido que se complete aquí se envía en el acto: este bucle ya acota su concurrencia (CONCURRENCY) y su tiempo.
        const result = await settleUnpaidOrder({ kind, order, emailInline: true });
        if (result.stuck) stuckOver24h += 1;
        switch (result.outcome) {
          case 'completed':
            completed += 1;
            break;
          case 'released':
            released += 1;
            break;
          case 'pending':
            stillPending += 1;
            break;
          case 'processing':
            processing += 1;
            break;
          case 'unknown':
            // La pasarela no se pudo consultar: el pedido sigue PENDING para la siguiente pasada y cuenta como error de la pasada.
            unknown += 1;
            noteError(kind, order.id, result.reason ?? 'unknown');
            break;
          case 'attention':
            noteError(kind, order.id, result.reason ?? 'attention');
            break;
        }
      } catch (error) {
        noteError(kind, order.id, error instanceof Error ? error.message : String(error));
        console.error(
          `[GET /api/cron/reconcile-payments] [cliente ${tenantTag()}] Error reconciliando ${kind} ${order.id}:`,
          error instanceof Error ? error.message : error
        );
      }
    };

    // Grupos de CONCURRENCY pedidos. Cada grupo se sella JUSTO ANTES de llamar a las pasarelas (si la función se corta por tiempo a mitad de grupo,
    // la siguiente pasada ya no empieza por esos), y lo que no llega a atenderse por falta de tiempo NO se sella: sigue con su sitio en la cola justa.
    let examined = 0;
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      if (Date.now() >= deadline) break;
      const group = queue.slice(i, i + CONCURRENCY);
      const stampedAt = new Date();
      await Promise.all([
        stampExamined('order', group.filter((g) => g.table === 'order').map((g) => g.order.id), stampedAt),
        stampExamined('shopOrder', group.filter((g) => g.table === 'shopOrder').map((g) => g.order.id), stampedAt),
      ]);
      await Promise.all(group.map(settleOne));
      examined += group.length;
    }
    const deferred = queue.length - examined;

    // Antigüedad del pedido con pago en la pasarela que sigue sin resolverse (0 = ninguno): es la señal que el panel puede vigilar (SLI «edad máx. de PENDING»).
    const [oldestOrder, oldestShop] = await Promise.all([
      prisma.order.aggregate({ where: { status: 'PENDING', paymentId: { not: null } }, _min: { createdAt: true } }),
      prisma.shopOrder.aggregate({ where: { status: 'PENDING', paymentId: { not: null } }, _min: { createdAt: true } }),
    ]);
    const oldest = [oldestOrder._min.createdAt, oldestShop._min.createdAt].filter((d): d is Date => d instanceof Date).sort((x, y) => x.getTime() - y.getTime())[0];
    const oldestPendingMinutes = oldest ? Math.max(0, Math.floor((now - oldest.getTime()) / 60_000)) : 0;

    // Si todo lo examinado dio error y no hubo ni un avance (nada completado, liberado, en curso ni confirmado como aún pendiente), la pasada NO
    // ha reconciliado nada: credencial ilegible, caducada o mal puesta, pasarela sin configurar o caída. Un 200 haría que el disparador la diera por
    // buena y el operador no se enteraría de que los pedidos se quedan en PENDING.
    const failedPass = errors > 0 && completed + released + stillPending + processing === 0;
    if (failedPass) captureOpsError(new Error('reconcile_failed_pass'), { route: 'GET /api/cron/reconcile-payments', reason: 'failed_pass' });
    if (errors > 0) {
      console.error(
        `[reconcile] ${JSON.stringify({ tenantId: tenantTag(), errors, unknown, stuckOver24h, deferred, completed, released, stillPending, processing, oldestPendingMinutes, errorSamples })}`
      );
    }
    // Resumen de la pasada para el bloque `ops` de /api/health (sin migración: una fila de sistema en AppConfig). Un fallo al escribirlo no cambia la respuesta.
    // Se escribe ANTES del barrido de emails: pase lo que pase con el SMTP, el panel ve que la pasada terminó.
    await writeReconcileSummary({ lastRunAt: new Date().toISOString(), errors, unknown, processing, stuckOver24h });

    // P0-08: barrido de emails sin confirmar, DESPUÉS de reconciliar pagos y con su PROPIO presupuesto corto (`emailSweepBudgetMs`, sin pasar del plazo
    // de la pasada): este cron confirma cobros de SumUp y el panel lo espera, así que un SMTP lento no puede retenerlo. Mismo tope de concurrencia. Cada
    // envío tiene un tope duro y, aun así, el barrido entero se corta aquí a los (presupuesto + 4 s): lo que no cupo sigue para la siguiente pasada.
    // Nunca lanza: un fallo aquí no puede tumbar la conciliación.
    let emails: Awaited<ReturnType<typeof sweepUnsentOrderEmails>> | null = null;
    try {
      const sweepDeadline = Math.min(deadline, Date.now() + emailSweepBudgetMs());
      const hardStop = sweepDeadline - Date.now() + 4_000; // margen para el último envío (su tope duro es el resto del presupuesto + 3 s)
      let timer: ReturnType<typeof setTimeout> | undefined;
      emails = await Promise.race([
        sweepUnsentOrderEmails({ deadline: sweepDeadline, concurrency: CONCURRENCY, baseUrl: getFallbackBaseUrl() }),
        new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, hardStop)))),
      ]);
      if (timer) clearTimeout(timer);
    } catch (error) {
      console.error(`[GET /api/cron/reconcile-payments] [cliente ${tenantTag()}] Error en el barrido de emails:`, error instanceof Error ? error.message : error);
    }
    // P1-04: continúa las cancelaciones de evento (reembolsos y avisos) y los avisos de cambio de fecha que sigan en marcha. Presupuesto propio y corto, sin
    // pasar del plazo de la pasada; nunca lanza (un fallo aquí no tumba la conciliación).
    let eventNotices: EventNoticeSweepResult | null = null;
    try {
      eventNotices = await runEventNoticeSweep({ deadline: Math.min(deadline, Date.now() + 15_000), concurrency: CONCURRENCY });
    } catch (error) {
      console.error(`[GET /api/cron/reconcile-payments] [cliente ${tenantTag()}] Error en el barrido de avisos de evento:`, error instanceof Error ? error.message : error);
    }
    // P1-10: reintenta los avisos de pedido nuevo al vendedor que no salieron. Presupuesto corto y propio; nunca lanza.
    const shopNotices = await sweepShopNewOrderNotices({ deadline: Math.min(deadline, Date.now() + 10_000) });
    // P1-01: repara los pedidos REFUNDED que se quedaron con entradas activas (proceso muerto entre «reembolsado» y «entradas anuladas»). Nunca lanza.
    const refundRepairs = await repairRefundedOrders();
    return NextResponse.json(
      {
        // Pedidos atendidos en esta pasada; `deferred` = los que no cupieron en el presupuesto de tiempo y quedan para la siguiente.
        checked: examined,
        deferred,
        completed,
        released,
        stillPending,
        processing,
        unknown,
        stuckOver24h,
        errors,
        errorSamples,
        oldestPendingMinutes,
        // Barrido de reintentos de emails (P0-08); null si no pudo ejecutarse.
        emails,
        // Cancelaciones y cambios de fecha de evento atendidos (P1-04); null si no pudo ejecutarse.
        eventNotices,
        // Avisos de pedido nuevo de la tienda reintentados (P1-10).
        shopNotices,
        // Pedidos reembolsados con entradas activas reparados (P1-01).
        refundRepairs,
      },
      { status: failedPass ? 502 : 200 }
    );
  } catch (error) {
    return handleApiError(error, 'GET /api/cron/reconcile-payments');
  }
}
