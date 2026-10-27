import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { notify, type Alert } from './alerts';
import { isHealthy, markOpsUnalerted, probeTenantHealth, recordHealth, wasOnlyOpsDegraded } from './health';
import { opsAlertFor, type OpsKey } from './ops-rules';
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

export type TenantJob = { name: string; intervalMs: number; kind: 'cron' | 'health'; path?: string; maxBackoffMs?: number; /** Tiempo máximo de la llamada a un cliente si esta tarea necesita más que el general. */ callTimeoutMs?: number };

/** `reconcile-payments` puede tardar mucho más que las demás (pasarelas lentas, barrido de emails por un SMTP colgado): su función en el front dura hasta 60 s
 * (`maxDuration`). Con los 20 s generales el panel la cortaba a media pasada, contaba un fallo (backoff y aviso a los 3 seguidos) sobre la tarea que
 * confirma los cobros de SumUp, y el front ni siquiera llegaba a dejar su resumen. 55 s: justo por debajo de lo que el front puede tardar. */
export const RECONCILE_CALL_TIMEOUT_MS = 55_000;

export const TENANT_JOBS: Record<string, TenantJob> = {
  'reconcile-payments': { name: 'reconcile-payments', intervalMs: 5 * 60_000, kind: 'cron', path: '/api/cron/reconcile-payments', maxBackoffMs: 15 * 60_000, callTimeoutMs: RECONCILE_CALL_TIMEOUT_MS },
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

/** Fallos seguidos de una tarea tras los que se avisa. La salud es la más sensible (una caída se nota en ~10 min); el resto tolera un tropiezo suelto. */
export const alertAfterFailures = (job: TenantJob) => (job.kind === 'health' ? 2 : 3);
/** Tope de avisos por pasada: una caída general no debe mandar un mensaje por cliente. */
export const MAX_ALERTS_PER_RUN = 10;

export type DispatchOptions = {
  /** Cómo se envía un aviso (por defecto, los canales configurados en el entorno). Los tests lo sustituyen. */
  notify?: (alert: Alert) => Promise<unknown>;
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
    select: { id: true, tenantId: true, schemaVersion: true, tenant: { select: { name: true } }, domains: { where: { status: 'VERIFIED' }, select: { host: true, isPrimary: true } } },
  });
  return subs.map((s) => ({
    id: s.id,
    tenantId: s.tenantId,
    name: s.tenant.name,
    schemaVersion: s.schemaVersion,
    host: (s.domains.find((d) => d.isPrimary) ?? s.domains[0]).host,
  }));
}

export async function dispatchTenantJobs(opts: DispatchOptions = {}): Promise<DispatchSummary> {
  const now = opts.now ?? Date.now;
  const started = now();
  // El mismo presupuesto que usa el disparador (90 s con una función de 120 s): con uno menor que el plazo de reconcile-payments (55 s) esa tarea no cabría nunca.
  const budgetMs = opts.budgetMs ?? 90_000;
  const concurrency = Math.min(10, Math.max(1, opts.concurrency ?? 5));
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  /** Tiempo máximo de la llamada de CADA tarea: el que se pida en las opciones (tests) o el suyo propio, o el general. */
  const timeoutFor = (job: TenantJob) => opts.callTimeoutMs ?? job.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
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

  // Avisos: con tope por pasada, y un fallo al avisar nunca rompe la pasada.
  const send = opts.notify ?? ((a: Alert) => notify(a));
  let sentAlerts = 0;
  let omittedAlerts = 0;
  /** Devuelve si el aviso SALIÓ: false si lo omitió el tope o si fallaron todos los canales configurados (sin canales no hay nada que reintentar). */
  const emit = async (a: Alert): Promise<boolean> => {
    if (sentAlerts >= MAX_ALERTS_PER_RUN) {
      omittedAlerts += 1;
      return false;
    }
    sentAlerts += 1;
    try {
      const res = (await send(a)) as { sent?: string[]; failed?: string[] } | undefined;
      return !(res && (res.failed?.length ?? 0) > 0 && (res.sent?.length ?? 0) === 0);
    } catch {
      // un aviso que no sale no puede dejar a los demás clientes sin atender
      return false;
    }
  };

  const runOne = async (row: (typeof dueRows)[number]) => {
    const target = byId.get(row.subscriptionId)!;
    const job = TENANT_JOBS[row.job];
    const who = { name: target.name, host: target.host };
    const t0 = now();
    let success = false;
    let http: number | null = null;
    let error: string | null = null;
    let duration = 0;
    let healthChange: Alert | null = null;
    const opsChanges: Alert[] = [];
    let opsRaiseKeys: OpsKey[] = [];
    try {
      if (job.kind === 'health') {
        // Estado anterior, para avisar solo del CAMBIO (sano → degradado, degradado → sano) y no en cada pasada.
        const previous = await prisma.tenantHealth.findUnique({ where: { subscriptionId: target.id }, select: { ok: true, status: true, error: true } });
        const probe = await probeTenantHealth({ tenantId: target.tenantId, host: target.host, declaredSchema: target.schemaVersion }, { fetchImpl: opts.fetchImpl, timeoutMs: callTimeoutMs });
        // Si el cliente manda `ops` (P0-07), la evaluación de negocio sale de aquí (con la comprobación anterior como memoria).
        const opsEval = await recordHealth(target.id, probe, new Date(now()));
        if (probe.reachable && previous) {
          const healthy = isHealthy(probe);
          // Un «no ok» que venía SOLO de las señales de operación no cuenta como estado técnico anterior: de eso avisa el bloque de abajo.
          const previousOk = previous.ok || wasOnlyOpsDegraded(previous);
          if (!healthy && previousOk) healthChange = { severity: 'warning', title: `${target.name}: la web responde pero no está sana`, detail: probe.problems.join(' · '), tenant: who };
          else if (healthy && !previousOk && previous.status !== 'unreachable') healthChange = { severity: 'recovery', title: `${target.name}: la web vuelve a estar sana`, tenant: who };
        }
        // Señales de negocio: solo en el cambio (aparece, escala, se resuelve), igual que la salud técnica. Sin comprobación anterior también se avisa:
        // una señal de dinero activa en la primera lectura no debe esperar a «cambiar».
        if (probe.reachable && opsEval) {
          const alert = opsAlertFor(opsEval.raise);
          if (alert) {
            opsChanges.push({ severity: alert.severity, title: `${target.name}: ${alert.title}`, detail: alert.detail, tenant: who });
            opsRaiseKeys = opsEval.raise.map((f) => f.key);
          }
          if (opsEval.recovered) opsChanges.push({ severity: 'recovery', title: `${target.name}: las señales de operación vuelven a la normalidad`, tenant: who });
        }
        success = probe.reachable;
        http = probe.httpStatus;
        error = probe.reachable ? null : probe.error;
        duration = probe.latencyMs;
      } else {
        const res = await callTenant({ tenantId: target.tenantId, host: target.host }, job.path!, { fetchImpl: opts.fetchImpl, timeoutMs: timeoutFor(job), now });
        http = res.status;
        duration = res.durationMs;
        success = res.status !== null && res.status >= 200 && res.status < 300;
        error = success ? null : (res.error ?? `HTTP ${res.status}${res.status === 401 ? ' (el cliente rechazó el secreto de cron)' : ''}`);
      }
    } catch (err) {
      // Un fallo inesperado (p. ej. la BD de control al guardar la salud) es un fallo de ESTE cliente y esta tarea: no puede abortar la pasada
      // de los demás clientes ni dejar a este sin anotar (sin anotar no habría backoff ni `lastError`).
      success = false;
      error = `Error interno del disparador: ${err instanceof Error ? err.message : String(err)}`;
    }
    const failures = success ? 0 : row.consecutiveFailures + 1;
    const finished = now();
    let recorded = false;
    try {
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
      recorded = true;
    } catch (err) {
      // Sin anotar, la fila sigue vencida y se reintenta en la siguiente pasada.
      console.error(`[cron-dispatch] no se pudo anotar el estado de ${row.job} del cliente ${target.tenantId}:`, err instanceof Error ? err.message : err);
    }
    // Avisos SOLO si el estado quedó anotado: si no, la fila se repite en la siguiente pasada con el mismo contador y el aviso saldría otra vez.
    if (recorded) {
      const threshold = alertAfterFailures(job);
      if (!success && failures === threshold) {
        await emit({ severity: 'critical', title: `${target.name}: la tarea «${row.job}» falla`, detail: `${failures} fallos seguidos. ${error ?? ''}`, tenant: who });
      } else if (success && row.consecutiveFailures >= threshold) {
        await emit({ severity: 'recovery', title: `${target.name}: la tarea «${row.job}» se ha recuperado`, tenant: who });
      }
      if (healthChange) await emit(healthChange);
      // La línea de cada señal ya se guardó al registrar la salud: si su aviso NO salió (tope de avisos por pasada, canal caído), se marca como
      // pendiente para que la siguiente pasada la avise en lugar de darla por avisada.
      let opsUndelivered = false;
      for (const change of opsChanges) if (!(await emit(change)) && change.severity !== 'recovery') opsUndelivered = true;
      if (opsUndelivered) await markOpsUnalerted(target.id, opsRaiseKeys).catch(() => undefined);
    } else if (opsRaiseKeys.length) {
      // El estado de la tarea no quedó anotado: no se avisa ahora (saldría duplicado al repetirse la fila), pero tampoco puede perderse.
      await markOpsUnalerted(target.id, opsRaiseKeys).catch(() => undefined);
    }
    const pj = (summary.perJob[row.job] ??= { ran: 0, ok: 0, failed: 0 });
    summary.ran += 1;
    pj.ran += 1;
    if (success) {
      summary.ok += 1;
      pj.ok += 1;
    } else {
      summary.failed += 1;
      pj.failed += 1;
      // Con el cliente y la tarea: en el log de Vercel es lo único que dice QUÉ cliente está fallando.
      console.error(`[cron-dispatch] ${row.job} falló para el cliente ${target.tenantId} (${target.host}), ${failures} seguidos: ${error ?? 'sin detalle'}`);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, dueRows.length) }, async () => {
      while (next < dueRows.length) {
        // No se lanza una llamada que podría acabar pasado el presupuesto (la función serverless moriría sin anotar el estado).
        // (con el tiempo máximo de ESA tarea: una llamada de 55 s no puede empezar a los 60 s de un presupuesto de 90)
        if (now() - started >= budgetMs - timeoutFor(TENANT_JOBS[dueRows[next].job])) return; // sin presupuesto: lo que queda espera a la siguiente invocación
        await runOne(dueRows[next++]);
      }
    })
  );
  summary.deferred = dueRows.length - next;
  if (omittedAlerts > 0) {
    try {
      await send({ severity: 'warning', title: `${omittedAlerts} avisos más en esta pasada`, detail: 'Varios clientes cambian de estado a la vez: mira la página Salud del panel.' });
    } catch {
      // ídem
    }
  }
  return summary;
}

/**
 * Código HTTP con el que el disparador responde (lo que ven Vercel Cron y cualquier monitor). Un 200 con clientes en rojo hacía que el cron
 * «pasara» mientras todos los clientes fallaban: ahora falla la invocación si alguna tarea falló, o si había tareas vencidas y no se pudo
 * lanzar ninguna (presupuesto de tiempo mal configurado).
 */
export function dispatchHttpStatus(summary: Pick<DispatchSummary, 'due' | 'ran' | 'failed'>): 200 | 500 {
  if (summary.failed > 0) return 500;
  if (summary.due > 0 && summary.ran === 0) return 500;
  return 200;
}
