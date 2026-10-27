import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import type { Alert } from '@/lib/services/alerts';
import { DEFAULT_CALL_TIMEOUT_MS, RECONCILE_CALL_TIMEOUT_MS, TENANT_JOBS, alertAfterFailures, dispatchTenantJobs, nextRunDelay } from '@/lib/services/crons';
import { verifyDomainManually } from '@/lib/services/domains';
import { publishSubscription } from '@/lib/services/snapshot';
import { createTenant } from '@/lib/services/tenants';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';

process.env.PLATFORM_CRON_MASTER = generateMasterKey();
process.env.TENANT_URL_TEMPLATE = 'http://{host}:9999';

/* A2: el reconcile del front puede tardar más de 20 s (pasarelas lentas, barrido de emails con un SMTP colgado; su función dura hasta 60 s). El panel
 * le da un tiempo propio y su presupuesto de la pasada cuenta con él, sin tocar el de las demás tareas. */

async function publishedTenant() {
  const { actor } = await makeOperator('SUPERADMIN');
  const t = await createTenant(tenantInput() as never, actor);
  await verifyDomainManually(t.domain.id, actor);
  await publishSubscription(t.subscription.id, actor, freshStore());
  return t.subscription.id;
}

let asked: number[];
beforeEach(async () => {
  await resetControlDb();
  asked = [];
  // `AbortSignal.timeout` no usa los temporizadores simulados: se anota el plazo pedido y se devuelve una señal que no se cancela.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    asked.push(ms);
    return new AbortController().signal;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const ok200 = async () => new Response('{}', { status: 200 });

describe('tiempo de la llamada por tarea', () => {
  it('reconcile-payments lleva su propio plazo (por debajo de los 60 s del front); el resto, el general de 20 s', () => {
    expect(RECONCILE_CALL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_CALL_TIMEOUT_MS);
    expect(RECONCILE_CALL_TIMEOUT_MS).toBeLessThan(60_000);
    expect(TENANT_JOBS['reconcile-payments'].callTimeoutMs).toBe(RECONCILE_CALL_TIMEOUT_MS);
    expect(TENANT_JOBS['cleanup-waiting-room'].callTimeoutMs).toBeUndefined();
    expect(TENANT_JOBS.health.callTimeoutMs).toBeUndefined();
  });

  it('la llamada real al cliente lleva ese plazo; las otras tareas, 20 s', async () => {
    await publishedTenant();
    await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: ok200 });
    expect(asked).toEqual([RECONCILE_CALL_TIMEOUT_MS]);
    asked.length = 0;
    await dispatchTenantJobs({ jobs: ['cleanup-waiting-room'], fetchImpl: ok200 });
    expect(asked).toEqual([DEFAULT_CALL_TIMEOUT_MS]);
  });

  it('una opción explícita (tests, ajuste puntual) manda sobre el plazo de la tarea', async () => {
    await publishedTenant();
    await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: ok200, callTimeoutMs: 1_000 });
    expect(asked).toEqual([1_000]);
  });

  it('el presupuesto de la pasada cuenta con el plazo de ESA tarea: una llamada de 55 s no empieza si no cabe', async () => {
    await publishedTenant();
    await publishedTenant();
    let clock = 1_800_000_000_000;
    const slow = async () => {
      clock += 38_000; // la primera llamada tarda 38 s (más de 20, menos de 55: ya no es un fallo)
      return new Response('{}', { status: 200 });
    };
    // presupuesto 90 s: con 20 s de plazo la segunda (empieza a los 38 s) cabría; con 55 s no (38 + 55 > 90)
    const out = await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: slow, now: () => clock, budgetMs: 90_000, concurrency: 1 });
    expect(out).toMatchObject({ ran: 1, ok: 1, deferred: 1 });
    // y las tareas de 20 s sí caben: la misma situación con `cleanup-waiting-room` atiende a las dos
    clock = 1_800_000_000_000;
    const other = await dispatchTenantJobs({ jobs: ['cleanup-waiting-room'], fetchImpl: slow, now: () => clock, budgetMs: 90_000, concurrency: 1 });
    expect(other).toMatchObject({ ran: 2, deferred: 0 });
  });
});

describe('efecto en el backoff y en los 3 fallos seguidos', () => {
  it('una llamada lenta (entre 20 y 55 s) que acaba bien no cuenta fallo ni espacia la tarea; el backoff y el umbral de aviso siguen igual', async () => {
    const id = await publishedTenant();
    let clock = 1_800_000_000_000;
    const slowOk = async () => {
      clock += 30_000;
      return new Response('{}', { status: 200 });
    };
    await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: slowOk, now: () => clock });
    const row = await prisma.cronState.findUnique({ where: { subscriptionId_job: { subscriptionId: id, job: 'reconcile-payments' } } });
    expect(row).toMatchObject({ lastStatus: 'ok', consecutiveFailures: 0 });
    // el siguiente intento sigue siendo a los 5 min (menos la gracia), no se espacia
    expect(row!.nextRunAt.getTime() - clock).toBe(nextRunDelay(TENANT_JOBS['reconcile-payments'], 0));

    // Siguen valiendo: backoff exponencial con tope de 15 min y aviso crítico al tercer fallo seguido
    const job = TENANT_JOBS['reconcile-payments'];
    expect([1, 2, 3, 4].map((n) => nextRunDelay(job, n))).toEqual([5 * 60_000, 10 * 60_000, 15 * 60_000, 15 * 60_000]);
    expect(alertAfterFailures(job)).toBe(3);
  });

  it('un cliente que NO responde en 55 s sigue contando como fallo y avisa al tercero', async () => {
    const id = await publishedTenant();
    const alerts: Alert[] = [];
    let clock = 1_800_000_000_000;
    const timesOut = async () => {
      clock += RECONCILE_CALL_TIMEOUT_MS;
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    for (let i = 0; i < 3; i++) {
      await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: timesOut, now: () => clock, notify: async (a) => void alerts.push(a) });
      clock += 3 * 3_600_000;
    }
    const row = await prisma.cronState.findUnique({ where: { subscriptionId_job: { subscriptionId: id, job: 'reconcile-payments' } } });
    expect(row).toMatchObject({ lastStatus: 'error', consecutiveFailures: 3 });
    expect(alerts.filter((a) => a.severity === 'critical')).toHaveLength(1);
  });
});
