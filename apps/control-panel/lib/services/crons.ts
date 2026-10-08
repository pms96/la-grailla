import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { probeTenantHealth, recordHealth } from './health';
import { callTenant, type FetchLike } from './tenant-calls';

/* Disparador de tareas periódicas POR CLIENTE (M7). Sustituye a los workflows de GitHub con la URL de La Grailla clavada y un único
 * secreto: un solo disparador (cron de GitHub o de Vercel) llama al panel y el panel recorre los clientes.
 *
 *  - Cada llamada a un cliente lleva el secreto de cron DE ESE cliente (derivado del maestro y su tenantId).
 *  - `CronState` guarda, por cliente y tarea, cuándo toca y cuántos fallos seguidos lleva. Un cliente que falla se espacia solo
 *    (backoff exponencial con tope) y no frena a los demás: no hay «cabeza de cola».
 *  - Presupuesto de tiempo: una invocación no pasa de `budgetMs` (las funciones serverless tienen tope). Lo que no cabe queda para la
 *    siguiente, y se atiende primero lo que lleva más tiempo sin ejecutarse (nunca-ejecutadas primero).
 *  - Sin estado en memoria: cualquier réplica del panel puede dispararlo. */

export type TenantJob = { name: string; intervalMs: number; kind: 'cron' | 'health'; path?: string; maxBackoffMs?: number };

export const TENANT_JOBS: Record<string, TenantJob> = {
  'reconcile-payments': { name: 'reconcile-payments', intervalMs: 5 * 60_000, kind: 'cron', path: '/api/cron/reconcile-payments', maxBackoffMs: 15 * 60_000 },
  'cleanup-waiting-room': { name: 'cleanup-waiting-room', intervalMs: 30 * 60_000, kind: 'cron', path: '/api/cron/cleanup-waiting-room' },
  health: { name: 'health', intervalMs: 5 * 60_000, kind: 'health' },
};

/** Margen para que un disparador que llega unos segundos «antes» de lo previsto no salte una vuelta entera. */
export const DUE_GRACE_MS = 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
/** Tiempo máximo de una llamada a un cliente si no se indica otro. */
export const DEFAULT_CALL_TIMEOUT_MS = 20_000;

/** Próxima ejecución tras `failures` fallos seguidos (0 = éxito). La salud no se espacia: interesa verla caer y recuperarse. */
export function nextRunDelay(job: TenantJob, failures: number): number {
  if (failures <= 0 || job.kind === 'health') return Math.max(0, job.intervalMs - DUE_GRACE_MS);
  // Un cobro SumUp sin webhook solo se confirma con esta tarea: su espera máxima es corta (15 min) aunque el cliente lleve horas fallando.
  return Math.min(job.maxBackoffMs ?? MAX_BACKOFF_MS, job.intervalMs * 2 ** (failures - 1));
}

export type DispatchOptions = {
  now?: () => number;
  jobs?: string[];
  budgetMs?: number;
  concurrency?: number;
  fetchImpl?: FetchLike;
  callTimeoutMs?: number;
};

export type DispatchSummary = {
  due: number;
  ran: number;
  ok: number;
  failed: number;
  /** Pendientes que no cupieron en el presupuesto de esta invocación. */
  deferred: number;
  perJob: Record<string, { ran: number; ok: number; failed: number }>;
};

/** Clientes a los que se les lanzan tareas: con web publicada y no en borrado. Un cliente SUSPENDIDO sigue (sus cobros en vuelo se reconcilian). */
async function targets() {
  const subs = await prisma.subscription.findMany({
    where: { tenant: { status: { in: ['ACTIVE', 'SUSPENDED'] } }, lastPublishedAt: { not: null }, domains: { some: { status: 'VERIFIED' } } },
    select: { id: true, tenantId: true, schemaVersion: true, domains: { where: { status: 'VERIFIED' }, select: { host: true, isPrimary: true } } },
  });
  return subs.map((s) => ({
    id: s.id,
    tenantId: s.tenantId,
    schemaVersion: s.schemaVersion,
    host: (s.domains.find((d) => d.isPrimary) ?? s.domains[0]).host,
  }));
}

export async function dispatchTenantJobs(opts: DispatchOptions = {}): Promise<DispatchSummary> {
  const now = opts.now ?? Date.now;
  const started = now();
  const budgetMs = opts.budgetMs ?? 40_000;
  const concurrency = Math.min(10, Math.max(1, opts.concurrency ?? 5));
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const jobs = (opts.jobs?.length ? opts.jobs : Object.keys(TENANT_JOBS)).map((j) => {
    const def = TENANT_JOBS[j];
    if (!def) throw new Error(`Tarea desconocida: ${j}`);
    return def;
  });

  const subs = await targets();
  const byId = new Map(subs.map((s) => [s.id, s]));
  // Las filas que faltan se crean ya vencidas; las de clientes que ya no cuentan se ignoran.
  const data: Prisma.CronStateCreateManyInput[] = subs.flatMap((s) => jobs.map((j) => ({ subscriptionId: s.id, job: j.name, nextRunAt: new Date(now()) })));
  if (data.length) await prisma.cronState.createMany({ data, skipDuplicates: true });

  const dueRows = await prisma.cronState.findMany({
    where: { job: { in: jobs.map((j) => j.name) }, subscriptionId: { in: subs.map((s) => s.id) }, nextRunAt: { lte: new Date(now()) } },
    // Nunca ejecutadas primero, después las que llevan más tiempo sin correr: ningún cliente se queda atrás.
    orderBy: [{ lastRunAt: { sort: 'asc', nulls: 'first' } }, { subscriptionId: 'asc' }],
  });

  const summary: DispatchSummary = { due: dueRows.length, ran: 0, ok: 0, failed: 0, deferred: 0, perJob: {} };
  let next = 0;

  const runOne = async (row: (typeof dueRows)[number]) => {
    const target = byId.get(row.subscriptionId)!;
    const job = TENANT_JOBS[row.job];
    const t0 = now();
    let success = false;
    let http: number | null = null;
    let error: string | null = null;
    let duration = 0;
    if (job.kind === 'health') {
      const probe = await probeTenantHealth({ tenantId: target.tenantId, host: target.host, declaredSchema: target.schemaVersion }, { fetchImpl: opts.fetchImpl, timeoutMs: callTimeoutMs });
      await recordHealth(target.id, probe, new Date(now()));
      success = probe.reachable;
      http = probe.httpStatus;
      error = probe.reachable ? null : probe.error;
      duration = probe.latencyMs;
    } else {
      const res = await callTenant({ tenantId: target.tenantId, host: target.host }, job.path!, { fetchImpl: opts.fetchImpl, timeoutMs: opts.callTimeoutMs, now });
      http = res.status;
      duration = res.durationMs;
      success = res.status !== null && res.status >= 200 && res.status < 300;
      error = success ? null : (res.error ?? `HTTP ${res.status}${res.status === 401 ? ' (el cliente rechazó el secreto de cron)' : ''}`);
    }
    const failures = success ? 0 : row.consecutiveFailures + 1;
    const finished = now();
    await prisma.cronState.update({
      where: { subscriptionId_job: { subscriptionId: row.subscriptionId, job: row.job } },
      data: {
        lastRunAt: new Date(t0),
        ...(success ? { lastSuccessAt: new Date(finished) } : {}),
        lastStatus: success ? 'ok' : 'error',
        lastHttp: http,
        lastDurationMs: duration,
        lastError: error ? error.slice(0, 500) : null,
        consecutiveFailures: failures,
        nextRunAt: new Date(finished + nextRunDelay(job, failures)),
      },
    });
    const pj = (summary.perJob[row.job] ??= { ran: 0, ok: 0, failed: 0 });
    summary.ran += 1;
    pj.ran += 1;
    if (success) {
      summary.ok += 1;
      pj.ok += 1;
    } else {
      summary.failed += 1;
      pj.failed += 1;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, dueRows.length) }, async () => {
      while (next < dueRows.length) {
        // No se lanza una llamada que podría acabar pasado el presupuesto (la función serverless moriría sin anotar el estado).
        if (now() - started >= budgetMs - callTimeoutMs) return; // sin presupuesto: lo que queda espera a la siguiente invocación
        await runOne(dueRows[next++]);
      }
    })
  );
  summary.deferred = dueRows.length - next;
  return summary;
}
