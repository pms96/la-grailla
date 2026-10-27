import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { escapeHtml as esc } from '@/lib/html-escape';
import { getPaymentProvider, paymentAccountFingerprint, type PaymentProvider, type PaidSession } from '@/lib/payment-adapter';
import { isModuleEnabled } from '@/lib/modules/runtime';
import { alertOperator } from '@/lib/reconciliation/shared';
import { captureOpsError } from '@/lib/observability/capture';
import { OPS_GATEWAY_KEY, type GatewaySummary } from '@/lib/ops-health';

/* Conciliación INVERSA pasarela → BD (OB-11, alerta nº 1 de la auditoría: «cobro sin pedido»).
 *
 * Todo lo demás parte de un pedido que existe (el cron de reconcile mira los PENDING; el webhook, el pedido que nombra). Un cobro cuyo pedido no
 * existe, o existe sin confirmar, solo se ve recorriendo la PASARELA y contrastando con la BD. Una vez al día por cliente (tarea `reconcile-gateway` del
 * panel), solo lectura:
 *
 *  - STRIPE: lista las sesiones de Checkout PAGADAS de las últimas 48 h (menos las de los últimos 45 min, que aún están en el flujo normal) y exige que
 *    cada una (con `metadata.orderId`, o sea, de esta plataforma) tenga su pedido pagado: por `paymentId`, o por el id de pedido de la metadata.
 *      · sin pedido                      → `no_order`
 *      · pedido PENDING o CANCELLED      → `order_not_confirmed`
 *    Un cargo reembolsado se da por resuelto (el dinero volvió).
 *  - SUMUP: su API no deja listar cobros por fecha con nuestra referencia (el historial de transacciones no la lleva), así que NO se puede detectar un
 *    cobro sin pedido. Lo que sí se hace es el sentido BD → pasarela para los pedidos sin pagar de las últimas 48 h: se pregunta a SumUp por su
 *    cobro (por `paymentId`, o por referencia si el pedido nunca guardó el suyo: `paid_reference_without_id`). Se anota en `skipped` que la
 *    cobertura de esa cuenta es parcial.
 *
 * Sin datos del comprador: se registran importes, ids de pedido y de sesión de pasarela. El resultado va a `ops_gateway_last` (bloque `ops` del health)
 * y, si hay algo, un aviso por los dos canales del operador (`alertOperator`, uno al día por conjunto distinto de cobros). Nunca lanza. */

export const GATEWAY_WINDOW_MS = 48 * 60 * 60_000;
/** Un cobro más reciente que esto aún puede estar siguiendo el flujo normal (webhook o cron cada 5 min): no se juzga. */
export const GATEWAY_MIN_AGE_MS = 45 * 60_000;
export const GATEWAY_MAX_PAGES = 10;
/** Pedidos sin pagar que se contrastan con SumUp por pasada (los más recientes primero). */
export const GATEWAY_SUMUP_ORDER_CAP = 150;
const CONCURRENCY = 5;

export type UnmatchedReason = 'no_order' | 'order_not_confirmed' | 'paid_reference_without_id';
export interface UnmatchedPayment {
  kind: 'entradas' | 'tienda';
  provider: 'stripe' | 'sumup';
  reason: UnmatchedReason;
  /** Id de la sesión/checkout en la pasarela (no es un dato personal). */
  gatewayId: string | null;
  /** Id del pedido en la BD, si lo hay. */
  orderId: string | null;
  amount: number | null;
  ageMinutes: number;
}

export interface GatewayResult {
  summary: GatewaySummary;
  /** Hasta 20 casos, para el aviso y el log. */
  samples: UnmatchedPayment[];
}

const REASON_TEXT: Record<UnmatchedReason, string> = {
  no_order: 'cobrado en la pasarela y sin pedido en la base de datos',
  order_not_confirmed: 'cobrado, pero su pedido sigue sin confirmar (pendiente o cancelado)',
  paid_reference_without_id: 'cobrado en SumUp, pero el pedido no guardó su cobro y no se ha confirmado',
};

const OK_ORDER = new Set(['COMPLETED', 'REFUNDED']);
const OK_SHOP = new Set(['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED']);

const minutesAgo = (now: number, d: Date) => Math.max(0, Math.floor((now - d.getTime()) / 60_000));
const chunk = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Stripe: contrasta las sesiones pagadas con la BD. */
async function checkStripeSessions(sessions: PaidSession[], now: number): Promise<UnmatchedPayment[]> {
  const ours = sessions.filter((s) => !s.refunded && s.orderId);
  const out: UnmatchedPayment[] = [];
  const orders = new Map<string, { id: string; status: string; shop: boolean }>();
  const byPayment = new Map<string, { id: string; status: string; shop: boolean }>();
  for (const part of chunk(ours, 200)) {
    const ids = part.map((s) => s.id);
    const orderIds = part.map((s) => s.orderId as string);
    const where = { OR: [{ paymentId: { in: ids } }, { id: { in: orderIds } }] };
    const [o, sh] = await Promise.all([
      prisma.order.findMany({ where, select: { id: true, status: true, paymentId: true } }),
      prisma.shopOrder.findMany({ where, select: { id: true, status: true, paymentId: true } }),
    ]);
    for (const [rows, shop] of [[o, false], [sh, true]] as const) {
      for (const r of rows) {
        const rec = { id: r.id, status: String(r.status), shop };
        orders.set(r.id, rec);
        if (r.paymentId) byPayment.set(r.paymentId, rec);
      }
    }
  }
  for (const s of ours) {
    const found = byPayment.get(s.id) ?? orders.get(s.orderId as string);
    const shop = found ? found.shop : s.orderType === 'shop';
    const base = { kind: shop ? ('tienda' as const) : ('entradas' as const), provider: 'stripe' as const, gatewayId: s.id, amount: s.amount, ageMinutes: minutesAgo(now, s.createdAt) };
    if (!found) out.push({ ...base, reason: 'no_order', orderId: s.orderId });
    else if (!(found.shop ? OK_SHOP : OK_ORDER).has(found.status)) out.push({ ...base, reason: 'order_not_confirmed', orderId: found.id });
  }
  return out;
}

/** SumUp: contrasta los pedidos sin pagar de las últimas 48 h con el cobro que SumUp tenga de ellos. Devuelve también cuántos candidatos quedaron fuera y si alguna consulta falló. */
async function checkSumUpOrders(
  provider: PaymentProvider,
  kind: 'entradas' | 'tienda',
  range: { from: Date; to: Date },
  now: number,
  deadline: number
): Promise<{ unmatched: UnmatchedPayment[]; checked: number; truncated: boolean; failed: boolean }> {
  const select = { id: true, paymentId: true, totalAmount: true, createdAt: true } as const;
  const createdAt = { gte: range.from, lte: range.to };
  const rows =
    kind === 'entradas'
      ? await prisma.order.findMany({ where: { paymentProvider: 'sumup', status: { in: ['PENDING', 'CANCELLED'] }, createdAt }, select, orderBy: { createdAt: 'desc' }, take: GATEWAY_SUMUP_ORDER_CAP + 1 })
      : // La tienda solo guarda `paymentProvider` junto con el `paymentId` (después de crear la sesión): un pedido cuyo id nunca se guardó tiene los dos nulos.
        await prisma.shopOrder.findMany({
          where: { OR: [{ paymentProvider: 'sumup' }, { paymentProvider: null, paymentId: null }], status: { in: ['PENDING', 'CANCELLED'] }, createdAt },
          select,
          orderBy: { createdAt: 'desc' },
          take: GATEWAY_SUMUP_ORDER_CAP + 1,
        });
  const truncated = rows.length > GATEWAY_SUMUP_ORDER_CAP;
  const candidates = rows.slice(0, GATEWAY_SUMUP_ORDER_CAP);
  const unmatched: UnmatchedPayment[] = [];
  let checked = 0;
  let failed = false;
  let cut = false;
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      if (Date.now() >= deadline) {
        cut = true;
        return;
      }
      const o = candidates[next++];
      const base = { kind, provider: 'sumup' as const, orderId: o.id, amount: Number(o.totalAmount), ageMinutes: minutesAgo(now, o.createdAt) };
      if (o.paymentId) {
        const r = await provider.verifyPayment(o.paymentId);
        if (r.status === 'UNKNOWN') failed = true;
        else checked += 1;
        if (r.status === 'PAID') unmatched.push({ ...base, reason: 'order_not_confirmed', gatewayId: o.paymentId });
      } else if (provider.findPaidByReference) {
        const r = await provider.findPaidByReference(o.id);
        if (r.error) failed = true;
        else checked += 1;
        if (r.paid && !r.refunded) unmatched.push({ ...base, reason: 'paid_reference_without_id', gatewayId: r.checkoutId ?? null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
  return { unmatched, checked, truncated: truncated || cut, failed };
}

/** Texto del aviso al operador: cada caso en una línea, sin datos del comprador. */
export function unmatchedAlertHtml(items: UnmatchedPayment[], total: number): string {
  const lines = items.slice(0, 10).map(
    (u) =>
      `<li><strong>${esc(u.kind)}</strong> · ${esc(u.provider)} · ${u.amount != null ? esc(u.amount.toFixed(2)) + ' €' : 'importe desconocido'} · hace ${Math.round(u.ageMinutes / 60)} h — ${esc(REASON_TEXT[u.reason])}` +
      `${u.gatewayId ? ` · cobro <code>${esc(u.gatewayId)}</code>` : ''}${u.orderId ? ` · pedido <code>${esc(u.orderId)}</code>` : ''}</li>`
  );
  return (
    `<p>La conciliación diaria con la pasarela ha encontrado <strong>${total}</strong> cobro(s) que no cuadran con la base de datos (últimas 48 h):</p><ul>${lines.join('')}</ul>` +
    (total > 10 ? `<p>… y ${total - 10} más.</p>` : '') +
    '<p>Qué hacer: abre el cobro en el panel de la pasarela. Si el cliente sigue esperando su pedido, confírmalo o reembólsalo a mano; este aviso se repite cada día mientras no se resuelva.</p>'
  );
}

/** Guarda el resultado de la pasada (clave de sistema `ops_gateway_last`). Nunca lanza. */
async function writeSummary(summary: GatewaySummary): Promise<void> {
  try {
    const value = JSON.stringify(summary);
    await prisma.appConfig.upsert({ where: { key: OPS_GATEWAY_KEY }, update: { value }, create: { key: OPS_GATEWAY_KEY, value, label: 'Última conciliación con la pasarela', group: 'sistema' } });
  } catch (error) {
    console.error('[reconcile-gateway] No se pudo guardar el resumen:', error instanceof Error ? error.message : error);
  }
}

export async function runGatewayReconciliation(opts: { now?: number; deadline?: number; maxPages?: number } = {}): Promise<GatewayResult> {
  const now = opts.now ?? Date.now();
  const deadline = opts.deadline ?? now + 30_000;
  const range = { from: new Date(now - GATEWAY_WINDOW_MS), to: new Date(now - GATEWAY_MIN_AGE_MS) };
  const unmatched: UnmatchedPayment[] = [];
  let checked = 0;
  let errors = 0;
  let skipped = 0;
  let truncated = false;
  const seen = new Set<string>();

  for (const kind of ['entradas', 'tienda'] as const) {
    if (!isModuleEnabled(kind)) continue;
    let provider: PaymentProvider;
    try {
      const fingerprint = await paymentAccountFingerprint(kind);
      if (!fingerprint) continue; // sin pasarela real: nada que conciliar
      const isStripe = fingerprint.startsWith('stripe:');
      // Una cuenta de Stripe se recorre UNA vez aunque la usen Entradas y Tienda (los pedidos de ambas se buscan en las dos tablas). SumUp va por módulo.
      const key = isStripe ? fingerprint : `${fingerprint}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      provider = await getPaymentProvider(kind);
    } catch (error) {
      errors += 1; // credencial ilegible o pasarela sin configurar: la conciliación no pudo mirar esta cuenta
      captureOpsError(error, { route: 'GET /api/cron/reconcile-gateway', kind, reason: 'provider_unavailable' });
      continue;
    }
    try {
      if (provider.listRecentPaid) {
        const listing = await provider.listRecentPaid({ ...range, maxPages: opts.maxPages ?? GATEWAY_MAX_PAGES, deadline });
        if (listing.error) {
          errors += 1;
          captureOpsError(new Error('gateway_list_failed'), { route: 'GET /api/cron/reconcile-gateway', kind, provider: provider.name, reason: 'list_failed' });
        }
        if (listing.truncated) truncated = true;
        const ours = listing.sessions.filter((s) => !s.refunded && s.orderId);
        checked += ours.length;
        unmatched.push(...(await checkStripeSessions(listing.sessions, now)));
      } else if (provider.findPaidByReference) {
        skipped += 1; // cobertura parcial: no se pueden detectar cobros sin pedido (ver cabecera)
        const r = await checkSumUpOrders(provider, kind, range, now, deadline);
        checked += r.checked;
        if (r.truncated) truncated = true;
        if (r.failed) errors += 1;
        unmatched.push(...r.unmatched);
      } else {
        skipped += 1;
      }
    } catch (error) {
      errors += 1;
      captureOpsError(error, { route: 'GET /api/cron/reconcile-gateway', kind, provider: provider.name, reason: 'check_failed' });
    }
  }

  const summary: GatewaySummary = { lastRunAt: new Date(now).toISOString(), checked, unmatched: unmatched.length, errors, skipped, truncated };
  await writeSummary(summary);

  if (unmatched.length > 0) {
    const first = unmatched[0];
    const set = createHash('sha256').update(unmatched.map((u) => `${u.gatewayId ?? ''}|${u.orderId ?? ''}`).sort().join(',')).digest('hex').slice(0, 12);
    await alertOperator({
      kind: first.kind,
      tag: '[gateway-reconcile]',
      orderId: first.orderId ?? first.gatewayId ?? '-',
      reason: 'paid_without_order',
      subject: `Cobros que no cuadran con los pedidos (${unmatched.length})`,
      html: unmatchedAlertHtml(unmatched, unmatched.length),
      // Un aviso al día por conjunto de cobros: el mismo caso sin resolver se recuerda cada día; uno nuevo avisa en el momento.
      dedupeKey: `gateway-unmatched:${set}`,
      details: { count: unmatched.length, reasons: [...new Set(unmatched.map((u) => u.reason))] },
    });
  }
  return { summary, samples: unmatched.slice(0, 20) };
}
