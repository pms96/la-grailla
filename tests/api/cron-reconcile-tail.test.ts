import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway, state } from '../helpers/fake-gateway';

vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return { ...actual, getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)) };
});

// Los cuatro barridos posteriores al bucle de pagos se sustituyen por espías que anotan el plazo que reciben y cuándo los llaman.
const calls = vi.hoisted(() => ({ list: [] as { name: string; deadline: number | undefined; at: number }[] }));
const spy = (name: string, result: unknown) => async (arg?: { deadline?: number }) => {
  calls.list.push({ name, deadline: arg?.deadline, at: Date.now() });
  return result;
};
vi.mock('@/lib/order-email', async (orig) => ({ ...(await orig<typeof import('@/lib/order-email')>()), sweepUnsentOrderEmails: spy('emails', { sent: 0 }) }));
vi.mock('@/lib/event-cancellation', async (orig) => ({ ...(await orig<typeof import('@/lib/event-cancellation')>()), runEventNoticeSweep: spy('events', { handled: 0 }) }));
vi.mock('@/lib/shop/shop-notices', async (orig) => ({ ...(await orig<typeof import('@/lib/shop/shop-notices')>()), sweepShopNewOrderNotices: spy('shop', { sent: 0 }) }));
vi.mock('@/lib/reconciliation/gateway-refund', async (orig) => ({
  ...(await orig<typeof import('@/lib/reconciliation/gateway-refund')>()),
  repairRefundedOrders: spy('repair', { repaired: 0, tickets: 0, reverted: 0, skipped: 0 }),
}));

const cronRoute = await import('@/app/api/cron/reconcile-payments/route');

/* H-029: los tres barridos de después del bucle (emails, avisos de evento, avisos al vendedor) usaban el mismo plazo de 35 s que el bucle de pagos: si éste lo
 * agotaba (pasarela lenta, mucha cola), arrancaban con el plazo YA vencido y no hacían nada, pasada tras pasada. El comentario «queda margen» era falso en el
 * peor caso. H-030: `repairRefundedOrders` no recibía plazo en absoluto. Ahora el bucle deja una reserva para la cola y todos los barridos reciben un plazo futuro. */

const run = async () => {
  const res = await cronRoute.GET(new Request('http://localhost/api/cron/reconcile-payments', { headers: { Authorization: 'Bearer test-cron-secret' } }));
  return { status: res.status, body: await res.json() };
};

describe('cron de reconciliación: la cola de barridos conserva su plazo (H-029, H-030)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;

  beforeAll(async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    event = await createTestEvent();
    tt = await createTicketType(event.id, { maxQuantity: 500 });
  });
  afterAll(async () => {
    for (const k of ['RECONCILE_TIME_BUDGET_MS', 'RECONCILE_HARD_STOP_MS', 'RECONCILE_TAIL_RESERVE_MS', 'RECONCILE_GROUP_GRACE_MS']) delete process.env[k];
    await cleanupTestEvent(event.id);
  });
  beforeEach(async () => {
    gateway.reset();
    gateway.active = true;
    calls.list = [];
    for (const k of ['RECONCILE_TIME_BUDGET_MS', 'RECONCILE_HARD_STOP_MS', 'RECONCILE_TAIL_RESERVE_MS', 'RECONCILE_GROUP_GRACE_MS']) delete process.env[k];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
  });
  afterEach(() => vi.restoreAllMocks());

  async function seed(n: number) {
    const base = Date.now() - 30 * 60_000;
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `tail-${Date.now()}-${i}`, eventId: event.id, buyerName: 'Cola', buyerLastName: 'Barridos', buyerEmail: `tail-${i}@example.com`, totalAmount: 10,
      paymentProvider: 'fake', paymentId: `cs_tail_${Date.now()}_${i}`, status: 'PENDING' as const, createdAt: new Date(base + i * 1000),
    }));
    await prisma.order.createMany({ data: rows });
    for (const r of rows) gateway.script(r.paymentId, state(r.paymentId, 'PENDING'));
  }

  const future = (name: string) => {
    const c = calls.list.find((x) => x.name === name);
    expect(c, `${name} no se llamó`).toBeDefined();
    expect(c!.deadline, `${name} sin plazo`).toBeDefined();
    expect(c!.deadline! - c!.at, `${name}: plazo ya vencido al arrancar`).toBeGreaterThan(0);
    return c!;
  };

  it('con el bucle de pagos agotado por una pasarela lenta, los cuatro barridos reciben un plazo futuro', async () => {
    await seed(10);
    gateway.verifyDelayMs = 120;
    process.env.RECONCILE_TIME_BUDGET_MS = '60'; // el bucle gasta su presupuesto con el primer grupo
    process.env.RECONCILE_HARD_STOP_MS = '2000';
    process.env.RECONCILE_TAIL_RESERVE_MS = '1200';
    const { status } = await run();
    expect(status).toBe(200);
    for (const name of ['emails', 'events', 'shop', 'repair']) future(name);
  });

  it('el plazo de los barridos nunca pasa del tope duro de la función', async () => {
    process.env.RECONCILE_HARD_STOP_MS = '1500';
    process.env.RECONCILE_TAIL_RESERVE_MS = '500';
    const t0 = Date.now();
    await run();
    for (const name of ['emails', 'events', 'shop', 'repair']) expect(future(name).deadline!, name).toBeLessThanOrEqual(t0 + 1500 + 50);
  });

  it('el bucle no puede invadir la reserva de la cola ni con un grupo colgado', async () => {
    await seed(5);
    gateway.verifyDelayMs = 5000; // la pasarela no contesta
    process.env.RECONCILE_TIME_BUDGET_MS = '10000';
    process.env.RECONCILE_GROUP_GRACE_MS = '10000';
    process.env.RECONCILE_HARD_STOP_MS = '1500';
    process.env.RECONCILE_TAIL_RESERVE_MS = '800';
    const t0 = Date.now();
    const { body } = await run();
    expect(body.groupTimedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500 + 300); // el bucle paró a ~700 ms y la cola respetó el tope
    for (const name of ['emails', 'events', 'shop', 'repair']) future(name);
  });

  it('repairRefundedOrders recibe un plazo y los barridos se reparten la cola (ninguno se queda con todo)', async () => {
    process.env.RECONCILE_HARD_STOP_MS = '3000';
    process.env.RECONCILE_TAIL_RESERVE_MS = '2000';
    const t0 = Date.now();
    await run();
    const emails = future('emails');
    const repair = future('repair');
    expect(emails.deadline!).toBeLessThan(repair.deadline!); // emails ≤ su parte; la reparación llega hasta el tope
    expect(repair.deadline!).toBeLessThanOrEqual(t0 + 3000 + 50);
  });

  it('con un presupuesto de bucle MAYOR que el tope, el bucle se corta igualmente en «tope − reserva» y deja lo que no cupo para la siguiente pasada', async () => {
    await seed(60);
    gateway.verifyDelayMs = 150; // 12 grupos de 5 = 1,8 s si nada lo corta
    process.env.RECONCILE_TIME_BUDGET_MS = '10000';
    process.env.RECONCILE_HARD_STOP_MS = '1500';
    process.env.RECONCILE_TAIL_RESERVE_MS = '800';
    const t0 = Date.now();
    const { body } = await run();
    expect(body.deferred).toBeGreaterThan(0);
    expect(body.checked).toBeLessThan(60);
    expect(Date.now() - t0).toBeLessThan(1500 + 300);
    for (const name of ['emails', 'events', 'shop', 'repair']) future(name);
  });
});

