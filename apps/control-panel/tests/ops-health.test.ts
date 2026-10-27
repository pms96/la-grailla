import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey, type OpsBlock } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import type { Alert } from '@/lib/services/alerts';
import { MAX_ALERTS_PER_RUN, dispatchTenantJobs } from '@/lib/services/crons';
import { verifyDomainManually } from '@/lib/services/domains';
import { publishSubscription } from '@/lib/services/snapshot';
import { createTenant } from '@/lib/services/tenants';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';

// Solo la sonda se simula en el disparador (para decidir qué manda el cliente); guardar la salud y avisar son reales.
vi.mock('@/lib/services/health', async (original) => ({ ...(await original<typeof import('@/lib/services/health')>()), probeTenantHealth: vi.fn() }));
import { probeTenantHealth as mockedProbe, type ProbeResult } from '@/lib/services/health';
const { probeTenantHealth } = await vi.importActual<typeof import('@/lib/services/health')>('@/lib/services/health');

process.env.PLATFORM_CRON_MASTER = generateMasterKey();
process.env.TENANT_URL_TEMPLATE = 'http://{host}:9999';

const MIN = 60_000;
const detail = (over: Record<string, unknown> = {}) => ({
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
const calmOps = (at: number, over: Partial<OpsBlock> = {}): OpsBlock => ({
  generatedAt: new Date(at).toISOString(),
  pendingOldestMinutes: null,
  pendingOver20min: 0,
  emailsUnsent: 0,
  emailsFailed: 0,
  reconcile: { lastRunAt: new Date(at - 2 * MIN).toISOString(), errors: 0, unknown: 0, processing: 0, stuckOver24h: 0 },
  ...over,
});
const probeWith = (ops: OpsBlock | null | undefined, problems: string[] = []): ProbeResult => ({ reachable: true, httpStatus: 200, latencyMs: 5, detail: detail(), problems, ...(ops !== undefined ? { ops } : {}) });

describe('probeTenantHealth con el bloque ops', () => {
  const target = { tenantId: '01JAAAAAAAAAAAAAAAAAAAAAAA', host: 'a.test', declaredSchema: '20261009090000_reconcile_queue' };
  const fetchOf = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

  it('un front anterior sin `ops` sigue siendo válido: sin problemas y sin señales', async () => {
    const r = await probeTenantHealth(target, { fetchImpl: fetchOf(detail()) });
    expect(r).toMatchObject({ reachable: true, problems: [], ops: null });
  });

  it('lee `ops` cuando viene y se queda solo con lo que conoce el contrato', async () => {
    const ops = { ...calmOps(Date.now(), { emailsFailed: 2 }), gatewayCredOk: true };
    const r = await probeTenantHealth(target, { fetchImpl: fetchOf(detail({ ops, campoNuevo: 1 })) });
    expect(r).toMatchObject({ reachable: true, problems: [] });
    if (r.reachable) {
      expect(r.ops).toMatchObject({ emailsFailed: 2, pendingOver20min: 0 });
      expect(JSON.stringify(r.ops)).not.toContain('gatewayCredOk');
    }
  });

  it('un `ops` mal formado NO deja al cliente como «no responde»: se señala aparte, sin copiar lo recibido', async () => {
    const r = await probeTenantHealth(target, { fetchImpl: fetchOf(detail({ ops: { generatedAt: 'comprador@correo.es', emailsUnsent: 'x' } })) });
    expect(r.reachable).toBe(true);
    expect(r.problems.join()).toMatch(/bloque «ops».*no cumple el contrato/);
    expect(r.problems.join()).not.toContain('comprador@correo.es');
    if (r.reachable) expect(r.ops).toBeNull();
  });
});

describe('señales de negocio en el disparador', () => {
  let alerts: Alert[];
  const spy = async (a: Alert) => void alerts.push(a);
  let t = Date.now();
  const clock = { now: () => t, next: (ms = 5 * MIN) => void (t += ms) };

  async function publishedTenant(name = 'Cliente Ops') {
    const { actor } = await makeOperator('SUPERADMIN');
    const created = await createTenant(tenantInput({ name }) as never, actor);
    await verifyDomainManually(created.domain.id, actor);
    await publishSubscription(created.subscription.id, actor, freshStore());
    return { name, host: created.domain.host, subscriptionId: created.subscription.id };
  }
  /** Una pasada de la tarea `health`, con lo que «manda» el cliente en ese momento. */
  const pass = async (probe: (now: number) => ProbeResult) => {
    vi.mocked(mockedProbe).mockResolvedValue(probe(clock.now()));
    await dispatchTenantJobs({ jobs: ['health'], notify: spy, now: clock.now });
    clock.next();
  };
  const stored = (subscriptionId: string) => prisma.tenantHealth.findUnique({ where: { subscriptionId } });

  beforeEach(async () => {
    await resetControlDb();
    alerts = [];
    t = Date.now();
    vi.mocked(mockedProbe).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('sin `ops` (front anterior) no se aplica ninguna regla ni se avisa de nada', async () => {
    const c = await publishedTenant();
    await pass(() => probeWith(null));
    await pass(() => probeWith(undefined));
    expect(alerts).toEqual([]);
    expect(await stored(c.subscriptionId)).toMatchObject({ ok: true, status: 'ok', error: null });
  });

  it('pedidos pendientes: avisa UNA vez al aparecer (incluso en la primera lectura), lo deja en la ficha, y avisa cuando se resuelve', async () => {
    const c = await publishedTenant('Peña Pagos');
    await pass((n) => probeWith(calmOps(n, { pendingOver20min: 2, pendingOldestMinutes: 24 })));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'warning', tenant: { name: 'Peña Pagos', host: c.host } });
    expect(alerts[0].title).toBe('Peña Pagos: pedidos pendientes de pago');
    expect(alerts[0].detail).toContain('2 en total');
    const row = await stored(c.subscriptionId);
    expect(row).toMatchObject({ ok: false, status: 'degraded' });
    expect(row?.error).toContain('Operación: pedidos pendientes de pago con más de 20 min');

    await pass((n) => probeWith(calmOps(n, { pendingOver20min: 2, pendingOldestMinutes: 29 }))); // sigue igual: no repite
    expect(alerts).toHaveLength(1);

    await pass((n) => probeWith(calmOps(n, { pendingOver20min: 2, pendingOldestMinutes: 34 }))); // escala a fallo
    expect(alerts.map((a) => a.severity)).toEqual(['warning', 'critical']);
    expect(alerts[1].title).toContain('sin resolver');

    await pass((n) => probeWith(calmOps(n)));
    expect(alerts.map((a) => a.severity)).toEqual(['warning', 'critical', 'recovery']);
    expect(alerts[2].title).toContain('vuelven a la normalidad');
    expect(await stored(c.subscriptionId)).toMatchObject({ ok: true, status: 'ok', error: null });
    await pass((n) => probeWith(calmOps(n)));
    expect(alerts).toHaveLength(3); // y estando bien no vuelve a avisar
  });

  it('emails sin enviar: no avisa por un tropiezo suelto, avisa al sostenerse 10 min', async () => {
    await publishedTenant();
    await pass((n) => probeWith(calmOps(n, { emailsUnsent: 1 })));
    expect(alerts).toHaveLength(0);
    await pass((n) => probeWith(calmOps(n, { emailsUnsent: 2 })));
    expect(alerts).toHaveLength(0);
    await pass((n) => probeWith(calmOps(n, { emailsUnsent: 2 }))); // 10 min desde la primera lectura
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain('emails sin enviar');
    await pass((n) => probeWith(calmOps(n, { emailsUnsent: 2 })));
    expect(alerts).toHaveLength(1);
  });

  it('emails fallidos y reconcile con errores o parado son FALLOS, en un solo aviso por pasada', async () => {
    await publishedTenant('Cliente Rojo');
    await pass((n) =>
      probeWith(calmOps(n, { emailsFailed: 1, reconcile: { lastRunAt: new Date(n - 40 * MIN).toISOString(), errors: 2, unknown: 1, processing: 0, stuckOver24h: 0 } }))
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', title: 'Cliente Rojo: 3 señales de operación' });
    expect(alerts[0].detail).toMatch(/error de envío/);
    expect(alerts[0].detail).toMatch(/el reconcile tiene errores/);
    expect(alerts[0].detail).toMatch(/el reconcile no corre/);
  });

  it('un aviso solo de operación y un problema técnico posterior no se pisan: cada uno avisa de lo suyo', async () => {
    await publishedTenant('Cliente Mixto');
    await pass((n) => probeWith(calmOps(n, { emailsFailed: 1 })));
    expect(alerts.map((a) => a.severity)).toEqual(['critical']);
    // el estado «degradado» anterior venía solo de operación: ahora aparece además un problema técnico y se avisa de él como siempre
    await pass((n) => probeWith(calmOps(n, { emailsFailed: 1 }), ['Datos sin completar: legal_notice']));
    expect(alerts.map((a) => a.severity)).toEqual(['critical', 'warning']);
    expect(alerts[1].title).toContain('no está sana');
    expect(alerts[1].detail).toBe('Datos sin completar: legal_notice');
  });

  const DOWN = (): ProbeResult => ({ reachable: false, httpStatus: null, latencyMs: 1, error: 'timeout', problems: ['El cliente no responde'] });

  it('M3: una caída del cliente CONSERVA las señales ya avisadas: al volver no se repite el aviso', async () => {
    const c = await publishedTenant();
    await pass((n) => probeWith(calmOps(n, { emailsFailed: 1 })));
    expect(alerts).toHaveLength(1);
    await pass(DOWN);
    const down = await stored(c.subscriptionId);
    expect(down?.status).toBe('unreachable');
    expect(down?.error).toContain('Operación: emails de confirmación con error de envío'); // la memoria sigue ahí
    expect(down?.error).toContain('timeout');
    await pass((n) => probeWith(calmOps(n, { emailsFailed: 1 })));
    expect(alerts.filter((a) => a.severity === 'critical')).toHaveLength(1); // sin aviso duplicado
  });

  it('M3: si el problema se resolvió durante la caída, al volver SÍ se avisa la recuperación (una vez)', async () => {
    await publishedTenant();
    await pass((n) => probeWith(calmOps(n, { emailsFailed: 1 })));
    await pass(DOWN);
    await pass(DOWN);
    await pass((n) => probeWith(calmOps(n)));
    expect(alerts.filter((a) => a.severity === 'recovery' && a.title.includes('operación'))).toHaveLength(1);
    await pass((n) => probeWith(calmOps(n)));
    expect(alerts.filter((a) => a.severity === 'recovery' && a.title.includes('operación'))).toHaveLength(1);
  });

  it('M3: con `ops` ausente, nulo o inválido en una lectura alcanzable tampoco se pierde la memoria', async () => {
    const c = await publishedTenant();
    await pass((n) => probeWith(calmOps(n, { emailsFailed: 2 })));
    expect(alerts).toHaveLength(1);
    await pass(() => probeWith(null)); // el front no pudo calcular `ops`
    expect((await stored(c.subscriptionId))?.error).toContain('Operación: emails de confirmación con error de envío');
    await pass(() => probeWith(undefined, ['El bloque «ops» de la salud no cumple el contrato (generatedAt: fecha ISO no válida)']));
    const row = await stored(c.subscriptionId);
    expect(row?.error).toContain('Operación: emails de confirmación con error de envío');
    expect(row).toMatchObject({ ok: false, status: 'degraded' });
    await pass((n) => probeWith(calmOps(n, { emailsFailed: 2 })));
    expect(alerts.filter((a) => a.severity === 'critical' && a.title.includes('error de envío'))).toHaveLength(1); // ni un aviso más por esto
  });

  describe('M3: un aviso que no salió no se da por avisado', () => {
    /** Una pasada de salud de TODOS los clientes, de uno en uno (así se sabe cuáles agotan el tope), con el canal de avisos que se indique. */
    const passAll = async (probe: (now: number) => ProbeResult, notify: (a: Alert) => Promise<unknown>) => {
      vi.mocked(mockedProbe).mockResolvedValue(probe(clock.now()));
      await dispatchTenantJobs({ jobs: ['health'], notify, now: clock.now, concurrency: 1 });
      clock.next();
    };

    it('los avisos omitidos por el tope de la pasada se avisan en la siguiente (y los ya avisados no se repiten)', async () => {
      const total = MAX_ALERTS_PER_RUN + 2;
      const subs: string[] = [];
      for (let i = 0; i < total; i++) subs.push((await publishedTenant(`Cliente ${i}`)).subscriptionId);
      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), spy);
      const first = alerts.filter((a) => a.severity === 'critical');
      expect(first).toHaveLength(MAX_ALERTS_PER_RUN);
      expect(alerts.filter((a) => a.severity === 'warning' && a.title.includes('2 avisos más'))).toHaveLength(1);
      const rows = await Promise.all(subs.map((id) => stored(id)));
      expect(rows.filter((r) => r?.error?.includes('[aviso pendiente]'))).toHaveLength(2); // exactamente los 2 omitidos

      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), spy);
      const second = alerts.filter((a) => a.severity === 'critical');
      expect(second).toHaveLength(total); // los 2 pendientes salen ahora, ninguno se repite
      expect(new Set(second.map((a) => a.title)).size).toBe(total);
      expect((await Promise.all(subs.map((id) => stored(id)))).filter((r) => r?.error?.includes('[aviso pendiente]'))).toHaveLength(0);

      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), spy);
      expect(alerts.filter((a) => a.severity === 'critical')).toHaveLength(total); // y a partir de aquí, silencio
    });

    it('si fallan todos los canales configurados el aviso se reintenta en la siguiente pasada; sin canales no se reintenta', async () => {
      const c = await publishedTenant();
      const sentTo: Alert[] = [];
      const broken = async (a: Alert) => {
        sentTo.push(a);
        return { sent: [], failed: ['webhook'] };
      };
      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), broken);
      expect(sentTo).toHaveLength(1);
      expect((await stored(c.subscriptionId))?.error).toContain('[aviso pendiente]');
      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), broken); // el canal sigue caído: se reintenta
      expect(sentTo).toHaveLength(2);
      const working = async (a: Alert) => {
        sentTo.push(a);
        return { sent: ['webhook'], failed: [] };
      };
      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), working); // vuelve el canal: sale
      expect(sentTo).toHaveLength(3);
      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), working);
      expect(sentTo).toHaveLength(3);
      expect((await stored(c.subscriptionId))?.error).not.toContain('[aviso pendiente]');

      // sin ningún canal configurado ({ sent: [], failed: [] }) no hay nada que reintentar: solo queda en el log
      await resetControlDb();
      const d = await publishedTenant();
      const none = async (a: Alert) => (void sentTo.push(a), { sent: [], failed: [] });
      const before = sentTo.length;
      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), none);
      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), none);
      expect(sentTo.length - before).toBe(1);
      expect((await stored(d.subscriptionId))?.error).not.toContain('[aviso pendiente]');
    });

    it('un canal que LANZA tampoco da el aviso por hecho', async () => {
      const c = await publishedTenant();
      const throwing = async () => {
        throw new Error('el canal cayó');
      };
      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), throwing);
      expect((await stored(c.subscriptionId))?.error).toContain('[aviso pendiente]');
      await passAll((n) => probeWith(calmOps(n, { emailsFailed: 1 })), spy);
      expect(alerts.filter((a) => a.severity === 'critical')).toHaveLength(1);
    });
  });

  it('lo que sale por el canal de avisos no lleva datos personales, URLs ni secretos', async () => {
    await publishedTenant();
    await pass((n) => probeWith(calmOps(n, { pendingOver20min: 5, pendingOldestMinutes: 70, emailsFailed: 3 })));
    for (const a of alerts) expect(JSON.stringify(a)).not.toMatch(/@|https?:\/\/|postgres|Bearer/);
  });
});
