import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { GET as abandonOrder } from '@/app/api/orders/[orderId]/abandon/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { gateway, state } from '../helpers/fake-gateway';

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

  // H-230: la cola se puede activar DESPUÉS de que el comprador cargara /comprar (props viejas: sin cola). El 403 lleva un código para que el formulario recargue y entre en la sala.
  it('H-230: sin turno (o con uno inválido) el 403 lleva `code: queue_required`', async () => {
    const none = await post('', 'turno-n@example.com', tt.id, event.id);
    expect(none.status).toBe(403);
    expect((await none.json()).code).toBe('queue_required');
    const bogus = await post('token-inventado', 'turno-n2@example.com', tt.id, event.id);
    expect(bogus.status).toBe(403);
    expect((await bogus.json()).code).toBe('queue_required');
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

  // H-219: el turno se gasta (COMPLETED) al crear el pedido y solo se restauraba si fallaba la pasarela. Quien pulsa «volver» en la pasarela sin pagar perdía su sitio y le decían
  // «ya completaste una compra». Ahora la `cancelUrl` lleva su turno y el abandono, si libera el pedido, se lo devuelve (mientras no haya caducado).
  describe('H-219: «volver» desde la pasarela devuelve el turno', () => {
    const buyWithGateway = async (email: string, t: { token: string }) => {
      gateway.active = true;
      const res = await post(t.token, email, tt.id, event.id);
      expect(res.status).toBe(200);
      const json = await res.json();
      // La pasarela dice que la sesión sigue abierta y, al cerrarla, que expiró (como en el abandono real): el pedido se libera.
      const { paymentId } = await prisma.order.findUniqueOrThrow({ where: { id: json.orderId }, select: { paymentId: true } });
      gateway.script(paymentId!, state(paymentId!, 'PENDING'), state(paymentId!, 'EXPIRED'));
      return { orderId: json.orderId as string, cancelUrl: gateway.sessions.at(-1)!.cancelUrl };
    };
    const goBack = (cancelUrl: string) => {
      const url = new URL(cancelUrl);
      const orderId = url.pathname.split('/')[3];
      return abandonOrder(new Request(`http://localhost${url.pathname}${url.search}`, { headers: { 'x-forwarded-for': freshIp() } }), { params: Promise.resolve({ orderId }) });
    };

    it('sin pagar: el pedido se libera y el turno vuelve a ADMITTED', async () => {
      const t = await turn();
      const { cancelUrl } = await buyWithGateway('turno-i@example.com', t);
      expect(await status(t.id)).toBe('COMPLETED');
      const res = await goBack(cancelUrl);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toMatch(/\/comprar$/); // el pedido se liberó: vuelve a la compra
      expect(await status(t.id)).toBe('ADMITTED');
    });

    it('un turno ya caducado no se resucita', async () => {
      const t = await turn({ expiresInMs: 600_000 });
      const { cancelUrl } = await buyWithGateway('turno-j@example.com', t);
      await prisma.waitingRoomEntry.update({ where: { id: t.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await goBack(cancelUrl);
      expect(await status(t.id)).toBe('COMPLETED');
    });

    it('un turno de OTRO evento o un token inventado en `q` no restaura nada', async () => {
      const t = await turn();
      const { cancelUrl } = await buyWithGateway('turno-k@example.com', t);
      const forged = new URL(cancelUrl);
      forged.searchParams.set('q', 'token-que-no-existe');
      await goBack(forged.toString());
      expect(await status(t.id)).toBe('COMPLETED');
    });
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

