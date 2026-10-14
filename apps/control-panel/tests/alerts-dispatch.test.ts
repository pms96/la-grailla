import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import type { Alert } from '@/lib/services/alerts';
import { MAX_ALERTS_PER_RUN, alertAfterFailures, dispatchTenantJobs, TENANT_JOBS } from '@/lib/services/crons';
import { verifyDomainManually } from '@/lib/services/domains';
import { publishSubscription } from '@/lib/services/snapshot';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';
import { createTenant } from '@/lib/services/tenants';

// Solo la sonda de salud se simula (para decidir qué ve el panel); guardar la salud y todo lo demás es real.
vi.mock('@/lib/services/health', async (original) => ({ ...(await original<typeof import('@/lib/services/health')>()), probeTenantHealth: vi.fn() }));
import { probeTenantHealth, type ProbeResult } from '@/lib/services/health';

process.env.PLATFORM_CRON_MASTER = generateMasterKey();
process.env.TENANT_URL_TEMPLATE = 'http://{host}:9999';

const detail = (over: Partial<Extract<ProbeResult, { reachable: true }>['detail']> = {}) => ({
  status: 'ok' as const,
  version: '1',
  platform: true,
  serving: true,
  tenantId: null,
  db: { ok: true, latencyMs: 3 },
  schema: { applied: '20261009090000_reconcile_queue', expected: '20261009090000_reconcile_queue', minRequired: '20261009090000_reconcile_queue', upToDate: true },
  onboarding: { complete: true, missing: [] as string[] },
  ...over,
});
const HEALTHY: ProbeResult = { reachable: true, httpStatus: 200, latencyMs: 5, detail: detail(), problems: [] };
const DEGRADED: ProbeResult = { reachable: true, httpStatus: 200, latencyMs: 5, detail: detail({ onboarding: { complete: false, missing: ['legal_notice'] } }), problems: ['Datos sin completar: legal_notice'] };
const DOWN: ProbeResult = { reachable: false, httpStatus: null, latencyMs: 20_000, error: 'timeout', problems: ['El cliente no responde'] };

async function publishedTenant(name = `Cliente ${Math.random().toString(36).slice(2, 7)}`) {
  const { actor } = await makeOperator('SUPERADMIN');
  const t = await createTenant(tenantInput({ name }) as never, actor);
  await verifyDomainManually(t.domain.id, actor);
  await publishSubscription(t.subscription.id, actor, freshStore());
  return { name, host: t.domain.host, subscriptionId: t.subscription.id };
}

/** Un reloj que se adelanta lo bastante entre pasadas para que todo vuelva a estar vencido (el backoff máximo es de una hora). */
function clock() {
  let t = Date.now();
  return { now: () => t, next: () => void (t += 3 * 3_600_000) };
}

const fail500 = async () => new Response('{}', { status: 500 });
const ok200 = async () => new Response('{}', { status: 200 });

let alerts: Alert[];
const spy = async (a: Alert) => void alerts.push(a);

beforeEach(async () => {
  await resetControlDb();
  alerts = [];
  vi.mocked(probeTenantHealth).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('tareas que fallan', () => {
  it('avisa al llegar al umbral de fallos seguidos (ni antes ni otra vez después) y avisa cuando se recupera', async () => {
    const t = await publishedTenant('Peña Prueba');
    const c = clock();
    const run = (fetchImpl: () => Promise<Response>) => dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl, notify: spy, now: c.now });
    const threshold = alertAfterFailures(TENANT_JOBS['reconcile-payments']);
    expect(threshold).toBe(3);

    for (let i = 1; i < threshold; i++) {
      await run(fail500);
      c.next();
      expect(alerts).toHaveLength(0);
    }
    await run(fail500); // el tercero seguido
    c.next();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', tenant: { name: 'Peña Prueba', host: t.host } });
    expect(alerts[0].title).toContain('reconcile-payments');
    expect(alerts[0].detail).toContain('3 fallos seguidos');

    await run(fail500); // el cuarto: ya se avisó, no se repite
    c.next();
    expect(alerts).toHaveLength(1);

    await run(ok200);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ severity: 'recovery' });
    c.next();
    await run(ok200); // y estando bien no vuelve a avisar
    expect(alerts).toHaveLength(2);
  });

  it('un fallo suelto que se recupera antes del umbral no avisa nada', async () => {
    await publishedTenant();
    const c = clock();
    const run = (fetchImpl: () => Promise<Response>) => dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl, notify: spy, now: c.now });
    await run(fail500);
    c.next();
    await run(fail500);
    c.next();
    await run(ok200);
    expect(alerts).toHaveLength(0);
  });

  it('si el estado no se pudo anotar no avisa (la fila se repetirá con el mismo contador y saldría duplicado)', async () => {
    await publishedTenant();
    const c = clock();
    const run = () => dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: fail500, notify: spy, now: c.now });
    await run();
    c.next();
    await run();
    c.next();
    const update = vi.spyOn(prisma.cronState, 'update').mockRejectedValueOnce(new Error('sin conexión'));
    await run(); // llegaría al tercero, pero no queda anotado
    update.mockRestore();
    expect(alerts).toHaveLength(0);
  });

  it('un aviso que no sale no rompe la pasada ni a los demás clientes', async () => {
    await publishedTenant();
    await publishedTenant();
    const c = clock();
    const broken = async () => {
      throw new Error('el canal cayó');
    };
    let summary = { ran: 0 };
    for (let i = 0; i < 3; i++) {
      summary = await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: fail500, notify: broken, now: c.now });
      c.next();
    }
    expect(summary.ran).toBe(2);
  });
});

describe('salud', () => {
  it('una web caída avisa a los 2 intentos seguidos (10 min) y avisa cuando vuelve', async () => {
    await publishedTenant('Cliente Salud');
    const c = clock();
    const run = (probe: ProbeResult) => {
      vi.mocked(probeTenantHealth).mockResolvedValue(probe);
      return dispatchTenantJobs({ jobs: ['health'], notify: spy, now: c.now });
    };
    await run(DOWN);
    c.next();
    expect(alerts).toHaveLength(0);
    await run(DOWN);
    c.next();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical' });
    expect(alerts[0].title).toContain('health');
    await run(HEALTHY);
    expect(alerts.map((a) => a.severity)).toEqual(['critical', 'recovery']);
  });

  it('avisa del CAMBIO de sano a degradado (no del primer registro ni de cada pasada) y de la vuelta a sano', async () => {
    await publishedTenant('Cliente Degradado');
    const c = clock();
    const run = async (probe: ProbeResult) => {
      vi.mocked(probeTenantHealth).mockResolvedValue(probe);
      await dispatchTenantJobs({ jobs: ['health'], notify: spy, now: c.now });
      c.next();
    };
    await run(DEGRADED); // primera comprobación: no hay estado previo, no es un «cambio»
    expect(alerts).toHaveLength(0);
    await run(HEALTHY);
    expect(alerts.map((a) => a.severity)).toEqual(['recovery']);
    await run(DEGRADED);
    expect(alerts.map((a) => a.severity)).toEqual(['recovery', 'warning']);
    expect(alerts[1].detail).toContain('legal_notice');
    await run(DEGRADED); // sigue igual: no se repite
    expect(alerts).toHaveLength(2);
  });
});

describe('tope de avisos por pasada', () => {
  it('con muchos clientes cayendo a la vez manda los primeros y un único resumen', async () => {
    const total = MAX_ALERTS_PER_RUN + 3;
    for (let i = 0; i < total; i++) await publishedTenant(`Cliente ${i}`);
    const c = clock();
    const run = () => dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: fail500, notify: spy, now: c.now, concurrency: 1 });
    await run();
    c.next();
    await run();
    c.next();
    expect(alerts).toHaveLength(0);
    await run(); // todos llegan al umbral a la vez
    const critical = alerts.filter((a) => a.severity === 'critical');
    const summary = alerts.filter((a) => a.severity === 'warning');
    expect(critical).toHaveLength(MAX_ALERTS_PER_RUN);
    expect(summary).toHaveLength(1);
    expect(summary[0].title).toContain('3 avisos más');
  });
});
