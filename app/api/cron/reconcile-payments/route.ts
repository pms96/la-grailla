export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { completeOrder } from '@/lib/order-reconciliation';
import { handleApiError } from '@/lib/api-error';

// Solo Stripe tiene webhook (app/api/webhooks/stripe) — SumUp no, así que un
// pedido pagado con SumUp solo se confirma hoy si el comprador vuelve a
// /confirmacion/[orderId] (ver GET de esa ruta). Si cierra la pestaña, pierde
// cobertura, o el redirect de SumUp falla, ese pedido y sus entradas se
// quedan en PENDING para siempre sin ningún mecanismo que lo reintente. Este
// cron es la red de seguridad: revisa periódicamente los pedidos pendientes
// y comprueba el estado real contra la pasarela, igual que ya hace esa
// misma ruta al vuelo.
const MIN_AGE_MS = 2 * 60_000; // deja margen a que el comprador siga en pleno checkout
const MAX_AGE_MS = 24 * 60 * 60_000; // más allá de esto se considera abandonado; no se sigue reintentando sin límite
const BATCH_SIZE = 50;

export async function GET(request: Request) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      console.error('[GET /api/cron/reconcile-payments] Falta CRON_SECRET en las variables de entorno');
      return NextResponse.json({ error: 'Cron no configurado' }, { status: 500 });
    }
    if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const now = Date.now();
    const pendingOrders = await prisma.order.findMany({
      where: {
        status: 'PENDING',
        paymentProvider: { notIn: ['mock'] },
        paymentId: { not: null },
        createdAt: { lte: new Date(now - MIN_AGE_MS), gte: new Date(now - MAX_AGE_MS) },
      },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });

    let completed = 0;
    let stillPending = 0;
    let errors = 0;

    for (const order of pendingOrders) {
      try {
        // paymentProvider/paymentId ya filtrados como no-null en la query,
        // pero TypeScript no lo sabe a partir del `where`.
        const provider = await getPaymentProviderByName(order.paymentProvider!);
        const result = await provider.verifyPayment(order.paymentId!);
        if (result.success) {
          await completeOrder(order.id);
          completed += 1;
        } else {
          stillPending += 1;
        }
      } catch (error) {
        errors += 1;
        console.error(`[GET /api/cron/reconcile-payments] Error verificando pedido ${order.id}:`, error instanceof Error ? error.message : error);
      }
    }

    return NextResponse.json({ checked: pendingOrders.length, completed, stillPending, errors });
  } catch (error) {
    return handleApiError(error, 'GET /api/cron/reconcile-payments');
  }
}
