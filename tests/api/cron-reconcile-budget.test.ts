import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import * as cronRoute from '@/app/api/cron/reconcile-payments/route';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway, state } from '../helpers/fake-gateway';

vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return { ...actual, getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)) };
});

/* M5: el cron tiene maxDuration, atiende los pedidos con concurrencia acotada y para a un presupuesto de tiempo dejando el resto SIN sellar
 * (conserva su sitio en la cola justa), con una pasarela falsa LENTA. */

const run = async () => {
  const res = await cronRoute.GET(new Request('http://localhost/api/cron/reconcile-payments', { headers: { Authorization: 'Bearer test-cron-secret' } }));
  return { status: res.status, body: await res.json() };
};

describe('cron de reconciliación: duración, concurrencia y presupuesto de tiempo', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  let ids: string[] = [];

  beforeAll(async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    event = await createTestEvent();
    tt = await createTicketType(event.id, { maxQuantity: 500 });
  });
  afterAll(async () => {
    delete process.env.RECONCILE_TIME_BUDGET_MS;
    await cleanupTestEvent(event.id);
  });
  beforeEach(async () => {
    gateway.reset();
    gateway.active = true;
    delete process.env.RECONCILE_TIME_BUDGET_MS;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    ids = [];
  });
  afterEach(() => vi.restoreAllMocks());

  /** `n` pedidos pendientes recientes (dentro del plazo: solo se verifican), creados con un segundo de diferencia para que la cola tenga orden. */
  async function seed(n: number) {
    const base = Date.now() - 30 * 60_000;
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `bud-${Date.now()}-${i}`, eventId: event.id, buyerName: 'Pre', buyerLastName: 'Supuesto', buyerEmail: `bud-${i}@example.com`, totalAmount: 10,
      paymentProvider: 'fake', paymentId: `cs_bud_${Date.now()}_${i}`, status: 'PENDING' as const, createdAt: new Date(base + i * 1000),
    }));
    await prisma.order.createMany({ data: rows });
    ids = rows.map((r) => r.id);
    for (const r of rows) gateway.script(r.paymentId, state(r.paymentId, 'PENDING'));
  }
  const attempts = async () => new Map((await prisma.order.findMany({ where: { id: { in: ids } } })).map((o) => [o.id, o.reconcileAttempts]));

  it('exporta maxDuration = 60 (como las otras rutas largas del repo)', () => {
    expect(cronRoute.maxDuration).toBe(60);
  });

  it('las llamadas a la pasarela van en paralelo con tope 5: 20 pedidos de 60 ms no tardan 1,2 s en serie ni lanzan 20 a la vez', async () => {
    await seed(20);
    gateway.verifyDelayMs = 60;
    const t0 = Date.now();
    const { body } = await run();
    const elapsed = Date.now() - t0;
    expect(body.checked).toBe(20);
    expect(body.deferred).toBe(0);
    expect(gateway.maxConcurrentVerifies).toBe(5);
    expect(elapsed).toBeLessThan(900); // en serie serían ≥ 1200 ms
    expect([...(await attempts()).values()].every((a) => a === 1)).toBe(true);
  });

  it('presupuesto agotado: el bucle para, lo no atendido NO se sella como examinado y se informa en `deferred`', async () => {
    await seed(40);
    gateway.verifyDelayMs = 80;
    process.env.RECONCILE_TIME_BUDGET_MS = '200'; // ~3 grupos de 5 a 80 ms
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body.checked).toBeGreaterThan(0);
    expect(body.checked).toBeLessThan(40);
    expect(body.deferred).toBe(40 - body.checked);
    const a = await attempts();
    const done = [...a.values()].filter((v) => v === 1).length;
    const untouched = [...a.values()].filter((v) => v === 0).length;
    expect(done).toBe(body.checked); // solo se selló lo atendido
    expect(untouched).toBe(body.deferred);
    const sealedRows = await prisma.order.findMany({ where: { id: { in: ids }, reconcileCheckedAt: null } });
    expect(sealedRows).toHaveLength(body.deferred); // los diferidos conservan reconcileCheckedAt = null (sitio en la cola)
  });

  it('cola justa conservada: en la pasada siguiente los diferidos pasan por delante de los ya atendidos', async () => {
    await seed(40);
    gateway.verifyDelayMs = 80;
    process.env.RECONCILE_TIME_BUDGET_MS = '200';
    const first = (await run()).body;
    const afterFirst = await attempts();
    const deferredIds = ids.filter((id) => afterFirst.get(id) === 0);
    expect(deferredIds.length).toBe(first.deferred);

    const second = (await run()).body;
    const afterSecond = await attempts();
    // La segunda pasada (mismo presupuesto) atiende primero a los diferidos: los primeros `checked` diferidos ya tienen 1 intento…
    for (const id of deferredIds.slice(0, second.checked)) expect(afterSecond.get(id), id).toBe(1);
    // …y ninguno de los ya atendidos en la primera se repite mientras queden diferidos.
    const alreadyDone = ids.filter((id) => afterFirst.get(id) === 1);
    if (deferredIds.length >= second.checked) for (const id of alreadyDone) expect(afterSecond.get(id), id).toBe(1);
  });

  it('con presupuesto de sobra no se difiere nada y la respuesta sigue siendo la de siempre', async () => {
    await seed(7);
    const { body } = await run();
    expect(body).toMatchObject({ checked: 7, deferred: 0, stillPending: 7, errors: 0 });
  });
});
