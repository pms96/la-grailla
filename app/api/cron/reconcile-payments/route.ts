export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { completeOrder, releaseExpiredOrder } from '@/lib/reconciliation/entradas';
import { completeShopOrder, releaseExpiredShopOrder } from '@/lib/reconciliation/tienda';
import { handleApiError } from '@/lib/api-error';
import { authorizeCron } from '@/lib/cron-auth';
import { currentTenant } from '@/lib/tenant/context';

// Solo Stripe tiene webhook (app/api/webhooks/stripe) — SumUp no, así que un
// pedido pagado con SumUp solo se confirma hoy si el comprador vuelve a
// /confirmacion/[orderId] (ver GET de esa ruta). Si cierra la pestaña, pierde
// cobertura, o el redirect de SumUp falla, ese pedido y sus entradas se
// quedan en PENDING para siempre sin ningún mecanismo que lo reintente. Este
// cron es la red de seguridad: revisa periódicamente los pedidos pendientes
// y comprueba el estado real contra la pasarela, igual que ya hace esa
// misma ruta al vuelo.
//
// Además, pasados MAX_AGE_MS libera el stock de PENDING que la pasarela no
// confirma como pagados (checkout abandonado) — crítico para SumUp, que no
// emite evento de expiración como Stripe.
const MIN_AGE_MS = 2 * 60_000; // deja margen a que el comprador siga en pleno checkout
const MAX_AGE_MS = 24 * 60 * 60_000; // ventana de reintentos de verificación
const BATCH_SIZE = 50;

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
    const minCreated = new Date(now - MAX_AGE_MS);
    const maxCreated = new Date(now - MIN_AGE_MS);

    const [pendingTicketOrders, abandonedTicketOrders, pendingShopOrders, abandonedShopOrders] =
      await Promise.all([
        prisma.order.findMany({
          where: {
            status: 'PENDING',
            paymentProvider: { notIn: ['mock'] },
            paymentId: { not: null },
            createdAt: { lte: maxCreated, gte: minCreated },
          },
          take: BATCH_SIZE,
          orderBy: FAIR_QUEUE_ORDER,
        }),
        // Más viejos que MAX_AGE: un último intento de verificar; si no hay
        // pago, liberar stock para no dejar el aforo bloqueado.
        prisma.order.findMany({
          where: {
            status: 'PENDING',
            createdAt: { lt: minCreated },
          },
          take: BATCH_SIZE,
          orderBy: FAIR_QUEUE_ORDER,
        }),
        prisma.shopOrder.findMany({
          where: {
            status: 'PENDING',
            paymentProvider: { notIn: ['mock'] },
            paymentId: { not: null },
            createdAt: { lte: maxCreated, gte: minCreated },
          },
          take: BATCH_SIZE,
          orderBy: FAIR_QUEUE_ORDER,
        }),
        prisma.shopOrder.findMany({
          where: {
            status: 'PENDING',
            createdAt: { lt: minCreated },
          },
          take: BATCH_SIZE,
          orderBy: FAIR_QUEUE_ORDER,
        }),
      ]);

    // Se sella ANTES de llamar a las pasarelas: si la función se corta por tiempo a mitad de pasada, la siguiente ya empieza por otros.
    const stampedAt = new Date(now);
    await Promise.all([
      stampExamined('order', [...pendingTicketOrders, ...abandonedTicketOrders].map((o) => o.id), stampedAt),
      stampExamined('shopOrder', [...pendingShopOrders, ...abandonedShopOrders].map((o) => o.id), stampedAt),
    ]);

    let completed = 0;
    let released = 0;
    let stillPending = 0;
    let errors = 0;

    for (const order of pendingTicketOrders) {
      try {
        const provider = await getPaymentProviderByName(order.paymentProvider!);
        const result = await provider.verifyPayment(order.paymentId!);
        if (result.success) {
          await completeOrder(order.id, undefined, result);
          completed += 1;
        } else if (result.status === 'EXPIRED') {
          // Una sesión de pago caducada ya no se puede pagar: se libera el aforo sin esperar a las 24 h.
          await releaseExpiredOrder(order.id);
          released += 1;
        } else {
          stillPending += 1;
        }
      } catch (error) {
        errors += 1;
        console.error(
          `[GET /api/cron/reconcile-payments] [cliente ${tenantTag()}] Errorverificando pedido ${order.id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    for (const order of abandonedTicketOrders) {
      try {
        if (order.paymentProvider && order.paymentProvider !== 'mock' && order.paymentId) {
          const provider = await getPaymentProviderByName(order.paymentProvider);
          const result = await provider.verifyPayment(order.paymentId);
          if (result.success) {
            await completeOrder(order.id, undefined, result);
            completed += 1;
            continue;
          }
        }
        await releaseExpiredOrder(order.id);
        released += 1;
      } catch (error) {
        errors += 1;
        console.error(
          `[GET /api/cron/reconcile-payments] [cliente ${tenantTag()}] Errorliberando pedido ${order.id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    for (const order of pendingShopOrders) {
      try {
        const provider = await getPaymentProviderByName(order.paymentProvider!, 'tienda');
        const result = await provider.verifyPayment(order.paymentId!);
        if (result.success) {
          await completeShopOrder(order.id, result);
          completed += 1;
        } else if (result.status === 'EXPIRED') {
          // Una sesión de pago caducada ya no se puede pagar: se libera el aforo sin esperar a las 24 h.
          await releaseExpiredShopOrder(order.id);
          released += 1;
        } else {
          stillPending += 1;
        }
      } catch (error) {
        errors += 1;
        console.error(
          `[GET /api/cron/reconcile-payments] [cliente ${tenantTag()}] Errorverificando shop ${order.id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    for (const order of abandonedShopOrders) {
      try {
        if (order.paymentProvider && order.paymentProvider !== 'mock' && order.paymentId) {
          const provider = await getPaymentProviderByName(order.paymentProvider, 'tienda');
          const result = await provider.verifyPayment(order.paymentId);
          if (result.success) {
            await completeShopOrder(order.id, result);
            completed += 1;
            continue;
          }
        }
        await releaseExpiredShopOrder(order.id);
        released += 1;
      } catch (error) {
        errors += 1;
        console.error(
          `[GET /api/cron/reconcile-payments] [cliente ${tenantTag()}] Errorliberando shop ${order.id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    // Si todo lo examinado dio error y no hubo ni un avance (nada completado, liberado ni confirmado como aún pendiente), la pasada NO
    // ha reconciliado nada: credencial ilegible, pasarela sin configurar o caída. Un 200 haría que el disparador la diera por buena y
    // el operador no se enteraría de que los pedidos se quedan en PENDING hasta que se libera el aforo a las 24 h.
    const failedPass = errors > 0 && completed + released + stillPending === 0;
    if (errors > 0) console.error(`[GET /api/cron/reconcile-payments] [cliente ${tenantTag()}] ${errors} pedidos con error de ${completed + released + stillPending + errors}`);
    return NextResponse.json(
      {
        checked:
          pendingTicketOrders.length +
          abandonedTicketOrders.length +
          pendingShopOrders.length +
          abandonedShopOrders.length,
        completed,
        released,
        stillPending,
        errors,
      },
      { status: failedPass ? 502 : 200 }
    );
  } catch (error) {
    return handleApiError(error, 'GET /api/cron/reconcile-payments');
  }
}
