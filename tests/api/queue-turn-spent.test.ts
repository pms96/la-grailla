import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';

vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return {
    ...actual,
    getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)),
    getPaymentProvider: async (s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProvider(s)),
  };
});
vi.mock('@/lib/mailer', async (orig) => ({ ...(await orig<typeof import('@/lib/mailer')>()), sendMail: async () => ({ success: true, transport: 'smtp' as const }) }));

/* H-035: un turno ADMITIDO de la sala de espera se podía gastar varias veces en paralelo: la comprobación (ADMITTED y vigente) y el paso a COMPLETED estaban
 * separados por toda la creación del pedido, así que dos peticiones simultáneas con el mismo turno compraban las dos. Ahora el turno se reclama DENTRO de la
 * transacción de la compra (que ya va serializada por evento): solo una lo gasta. */

let ipSeq = 0;
const runId = Math.floor(Math.random() * 60_000);
const freshIp = () => `10.${runId >> 8}.${runId & 255}.${(ipSeq += 1)}`;
const post = (queueToken: string, email: string, tt: string, eventId: string) =>
  createOrder(
    new Request('http://localhost/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ acceptedTerms: true, eventId, queueToken, buyerName: 'Ana', buyerLastName: 'Gil', buyerEmail: email, items: [{ ticketTypeId: tt, quantity: 1 }] }),
    })
  );

describe('turno de la sala de espera de un solo uso (H-035)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  let originalGateway: string | null;
  let n = 0;

  beforeAll(async () => {
    originalGateway = await getAndSetConfig('payment_gateway', 'mock');
    event = await createTestEvent({ maxCapacity: 100 });
    tt = await createTicketType(event.id, { maxQuantity: 100 });
    await prisma.event.update({ where: { id: event.id }, data: { waitingRoomEnabled: true } });
  });
  afterAll(async () => {
    await prisma.waitingRoomEntry.deleteMany({ where: { eventId: event.id } });
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
    await restoreConfig('payment_gateway', originalGateway);
  });
  beforeEach(() => {
    gateway.reset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const turn = (over: { expiresInMs?: number } = {}) =>
    prisma.waitingRoomEntry.create({
      data: { eventId: event.id, token: `turn-${Date.now()}-${n++}`, status: 'ADMITTED', admittedAt: new Date(), expiresAt: new Date(Date.now() + (over.expiresInMs ?? 600_000)) },
    });
  const status = async (id: string) => (await prisma.waitingRoomEntry.findUniqueOrThrow({ where: { id } })).status;

  it('dos compras simultáneas con el mismo turno: compra una sola, la otra recibe 403 y solo hay un pedido', async () => {
    const t = await turn();
    const results = await Promise.all([post(t.token, 'turno-a@example.com', tt.id, event.id), post(t.token, 'turno-b@example.com', tt.id, event.id)]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 403]);
    expect(await prisma.order.count({ where: { eventId: event.id, buyerEmail: { in: ['turno-a@example.com', 'turno-b@example.com'] } } })).toBe(1);
    expect(await status(t.id)).toBe('COMPLETED');
  });

  it('veinte compras simultáneas con el mismo turno: una sola', async () => {
    const t = await turn();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post(t.token, `turno-m${i}@example.com`, tt.id, event.id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(19);
  });

  it('un turno ya gastado no sirve para una segunda compra posterior', async () => {
    const t = await turn();
    expect((await post(t.token, 'turno-c@example.com', tt.id, event.id)).status).toBe(200);
    expect((await post(t.token, 'turno-d@example.com', tt.id, event.id)).status).toBe(403);
  });

  it('un turno caducado sigue sin servir', async () => {
    const t = await turn({ expiresInMs: -1000 });
    expect((await post(t.token, 'turno-e@example.com', tt.id, event.id)).status).toBe(403);
  });

  it('si la compra se rechaza (sin entradas), el turno NO se gasta: el comprador puede reintentar', async () => {
    const t = await turn();
    const res = await createOrder(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': freshIp() },
        body: JSON.stringify({ acceptedTerms: true, eventId: event.id, queueToken: t.token, buyerName: 'Ana', buyerLastName: 'Gil', buyerEmail: 'turno-f@example.com', items: [{ ticketTypeId: tt.id, quantity: 1000 }] }),
      })
    );
    expect(res.status).toBe(400);
    expect(await status(t.id)).toBe('ADMITTED');
    expect((await post(t.token, 'turno-f2@example.com', tt.id, event.id)).status).toBe(200);
  });

  it('si la pasarela falla al abrir la sesión de pago (502), el turno se conserva para reintentar', async () => {
    gateway.active = true;
    gateway.failCreate = true;
    const t = await turn();
    expect((await post(t.token, 'turno-g@example.com', tt.id, event.id)).status).toBe(502);
    expect(await status(t.id)).toBe('ADMITTED');
    gateway.failCreate = false;
    expect((await post(t.token, 'turno-g2@example.com', tt.id, event.id)).status).toBe(200);
  });

  it('un turno que caduca mientras la compra espera el cerrojo del evento ya no sirve al reclamarlo (403)', async () => {
    const t = await turn({ expiresInMs: 300 });
    // Otra transacción tiene el cerrojo del evento 700 ms: la compra pasa la comprobación de lectura (el turno aún vale) y espera; al entrar, ya caducó.
    const hold = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`;
        await new Promise((r) => setTimeout(r, 700));
      },
      { timeout: 10_000 }
    );
    await new Promise((r) => setTimeout(r, 100));
    const res = await post(t.token, 'turno-h@example.com', tt.id, event.id);
    await hold;
    expect(res.status).toBe(403);
    expect(await prisma.order.count({ where: { eventId: event.id, buyerEmail: 'turno-h@example.com' } })).toBe(0);
  });
});

