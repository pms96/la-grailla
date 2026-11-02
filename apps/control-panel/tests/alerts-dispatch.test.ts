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
// Fallo TÉCNICO grave (H-175): el front responde pero la BD no, o es la de otro cliente, o el esquema bloquea: `severe`.
const DB_DOWN: ProbeResult = { reachable: true, httpStatus: 503, latencyMs: 5, detail: detail({ status: 'error', db: { ok: false, latencyMs: 3 } }), problems: ['La base de datos no responde'], severe: true };
const WRONG_DB: ProbeResult = { reachable: true, httpStatus: 503, latencyMs: 5, detail: detail({ tenantMarker: 'otro-cliente' }), problems: ['LA BD ES DE OTRO CLIENTE (marcada como otro-cliente): revisa las URLs de BD de este cliente ya'], severe: true };
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

describe('un aviso crítico que no sale no se pierde (H-174)', () => {
  // Antes `failures === threshold` y el resultado de `emit` se ignoraba: si el canal fallaba (o el tope por pasada lo omitía) en ESE fallo, el contador seguía subiendo, nunca
  // volvía a igualar el umbral y la caída no se avisaba jamás (luego sí salía el «recuperado»). Ahora queda «aviso pendiente» y se reintenta en la siguiente pasada.
  const lossy = async (_a: Alert) => ({ sent: [] as string[], failed: ['ntfy'] });
  const channelDown = async () => {
    throw new Error('el canal cayó');
  };

  it('si el aviso del umbral no sale, la siguiente pasada fallida lo reintenta; una vez entregado no se repite', async () => {
    await publishedTenant('Peña Reintento');
    const c = clock();
    const run = (notify: (a: Alert) => Promise<unknown>) => dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: fail500, notify, now: c.now });
    const threshold = alertAfterFailures(TENANT_JOBS['reconcile-payments']);
    for (let i = 1; i < threshold; i++) {
      await run(spy);
      c.next();
    }
    await run(lossy); // el del umbral: el canal no lo entrega
    c.next();
    expect(alerts).toHaveLength(0);
    await run(spy); // un fallo más, ya con canal: se reintenta
    c.next();
    expect(alerts.map((a) => a.severity)).toEqual(['critical']);
    expect(alerts[0].title).toContain('reconcile-payments');
    await run(spy); // ya entregado: no se repite
    c.next();
    await run(spy);
    c.next();
    expect(alerts).toHaveLength(1);
  });

  it('un canal que LANZA al avisar tampoco lo pierde, y sigue reintentándose hasta que sale', async () => {
    await publishedTenant('Peña Canal Caído');
    const c = clock();
    const run = (notify: (a: Alert) => Promise<unknown>) => dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: fail500, notify, now: c.now });
    for (let i = 0; i < 3; i++) {
      await run(channelDown);
      c.next();
    }
    await run(channelDown); // la pendiente se reintenta y vuelve a fallar: sigue pendiente (no se da por avisada)
    c.next();
    expect(alerts).toHaveLength(0);
    await run(spy);
    expect(alerts.map((a) => a.severity)).toEqual(['critical']);
  });

  it('si se recupera sin que el aviso llegara a salir, no se manda un «recuperado» de algo que nunca se avisó… y la marca no queda en la fila', async () => {
    await publishedTenant('Peña Recupera');
    const c = clock();
    for (let i = 0; i < 3; i++) {
      await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: fail500, notify: lossy, now: c.now });
      c.next();
    }
    await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: ok200, notify: spy, now: c.now });
    const row = await prisma.cronState.findFirst({ where: { job: 'reconcile-payments' } });
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.lastError ?? '').not.toContain('aviso pendiente');
    // El «recuperado» sí sale (el operador debe saber que ya no falla, aunque no supiera que fallaba).
    expect(alerts.map((a) => a.severity)).toEqual(['recovery']);
  });
});

describe('un fallo técnico grave de la web no se queda en un solo warning (H-175)', () => {
  // Antes una BD caída, la BD de OTRO cliente o un esquema bloqueante contaban como «alcanzable» (el front responde 503 con JSON válido): `consecutiveFailures` quedaba a 0 y solo salía
  // un `warning` único en la transición, sin recordatorio. Ahora cuentan como fallo de la tarea: crítico a los 2 seguidos (con el reintento de H-174) y «recuperado» al volver.
  for (const [name, probe] of [['la BD no responde', DB_DOWN], ['la BD es de otro cliente', WRONG_DB]] as const) {
    it(`${name}: crítico a los 2 seguidos, sin repetirse, y UN solo «recuperado» al volver`, async () => {
      await publishedTenant('Cliente Grave');
      const c = clock();
      const run = async (p: ProbeResult) => {
        vi.mocked(probeTenantHealth).mockResolvedValue(p);
        await dispatchTenantJobs({ jobs: ['health'], notify: spy, now: c.now });
        c.next();
      };
      await run(HEALTHY);
      await run(probe);
      expect(alerts).toHaveLength(0); // un solo mal sondeo: aún no
      await run(probe);
      expect(alerts.map((a) => a.severity)).toEqual(['critical']);
      expect(alerts[0].detail).toContain(probe.problems[0].slice(0, 20));
      await run(probe);
      await run(probe);
      expect(alerts).toHaveLength(1); // no se repite
      await run(HEALTHY);
      expect(alerts.map((a) => a.severity)).toEqual(['critical', 'recovery']); // ni dos «recuperado»
    });
  }

  it('el estado de la tarea refleja el fallo (la ficha y el código HTTP del disparador lo ven)', async () => {
    await publishedTenant('Cliente Grave Estado');
    vi.mocked(probeTenantHealth).mockResolvedValue(DB_DOWN);
    const summary = await dispatchTenantJobs({ jobs: ['health'], notify: spy, now: clock().now });
    expect(summary).toMatchObject({ ran: 1, failed: 1 });
    const row = await prisma.cronState.findFirst({ where: { job: 'health' } });
    expect(row).toMatchObject({ lastStatus: 'error', consecutiveFailures: 1 });
    expect(row?.lastError).toContain('La base de datos no responde');
  });

  it('si el aviso crítico de un fallo grave no sale, se reintenta en la siguiente pasada', async () => {
    await publishedTenant('Cliente Grave Reintento');
    const c = clock();
    const lossy = async (_a: Alert) => ({ sent: [] as string[], failed: ['ntfy'] });
    const run = async (notify: (a: Alert) => Promise<unknown>) => {
      vi.mocked(probeTenantHealth).mockResolvedValue(DB_DOWN);
      await dispatchTenantJobs({ jobs: ['health'], notify, now: c.now });
      c.next();
    };
    await run(spy);
    await run(lossy); // el del umbral no sale
    expect(alerts).toHaveLength(0);
    await run(spy);
    expect(alerts.map((a) => a.severity)).toEqual(['critical']);
  });

  it('un problema NO grave (datos sin completar) sigue siendo un warning único en el cambio, no un fallo de la tarea', async () => {
    await publishedTenant('Cliente Leve');
    const c = clock();
    for (const p of [HEALTHY, DEGRADED, DEGRADED, DEGRADED]) {
      vi.mocked(probeTenantHealth).mockResolvedValue(p);
      await dispatchTenantJobs({ jobs: ['health'], notify: spy, now: c.now });
      c.next();
    }
    expect(alerts.map((a) => a.severity)).toEqual(['warning']);
    const row = await prisma.cronState.findFirst({ where: { job: 'health' } });
    expect(row?.consecutiveFailures).toBe(0);
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
