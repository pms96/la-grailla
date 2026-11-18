import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent, cleanupWarn } from '../helpers/fixtures';
import bcrypt from 'bcryptjs';

const staffEmail = `taquilla-test-${Date.now()}@test.local`;
let staffUserId: string;

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: staffUserId, role: 'TAQUILLA', email: staffEmail },
  })),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

const { POST: taquillaSale } = await import('@/app/api/taquilla/sale/route');

function saleRequest(body: unknown) {
  return new Request('http://localhost/api/taquilla/sale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/taquilla/sale', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: staffEmail,
        name: 'Taquilla Test',
        hashedPassword: await bcrypt.hash('test-pass', 4),
        role: 'TAQUILLA',
      },
    });
    staffUserId = user.id;

    event = await createTestEvent();
    ticketType = await createTicketType(event.id, { maxQuantity: 10 });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: staffUserId } }).catch(cleanupWarn);
    await cleanupTestEvent(event.id);
  });

  // AUDIT: un reintento de red tras un timeout (o doble tap en el datáfono)
  // podía cobrar y emitir entradas dos veces — /api/taquilla/sale no usaba
  // el idempotencyKey que el modelo Order ya soporta. Severidad: Alto.
  it('no duplica la venta cuando se reenvía con la misma idempotencyKey', async () => {
    const idempotencyKey = `test-idem-${Date.now()}`;
    const body = {
      eventId: event.id,
      buyerName: 'Idempotente',
      buyerLastName: 'Test',
      buyerEmail: '',
      items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
      paymentMethod: 'cash',
      idempotencyKey,
    };

    const res1 = await taquillaSale(saleRequest(body));
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.success).toBe(true);

    const res2 = await taquillaSale(saleRequest(body));
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.orderId).toBe(data1.orderId);

    const orderCount = await prisma.order.count({ where: { idempotencyKey } });
    expect(orderCount).toBe(1);

    const ticketCount = await prisma.ticket.count({ where: { orderId: data1.orderId } });
    expect(ticketCount).toBe(1);
  });

  // H-206: dos envíos simultáneos con la misma `idempotencyKey` (doble tap en el datáfono) pasan los dos la comprobación previa; el segundo choca con el UNIQUE de Postgres al
  // crear el pedido (P2002) y devolvía un 500 en vez del pedido que acababa de registrar el primero (en entradas online ya se devolvía).
  it('H-206: si la carrera de la clave llega al UNIQUE (P2002), devuelve la venta ya registrada, no un 500', async () => {
    const idempotencyKey = `test-idem-race-${Date.now()}`;
    const body = {
      eventId: event.id,
      buyerName: 'Carrera',
      buyerLastName: 'Test',
      buyerEmail: '',
      items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
      paymentMethod: 'cash',
      idempotencyKey,
    };
    const first = await taquillaSale(saleRequest(body));
    expect(first.status).toBe(200);
    const { orderId } = await first.json();

    // La segunda petición mira si ya existe la venta ANTES de que la primera la confirme: no la ve (null una vez) y sigue adelante hasta chocar con el UNIQUE.
    const real = (globalThis as unknown as { prisma: typeof prisma }).prisma;
    const original = real.order.findUnique.bind(real.order) as (...a: unknown[]) => unknown;
    let hidden = false;
    const spy = vi.spyOn(real.order, 'findUnique').mockImplementation(((...a: unknown[]) => (hidden ? original(...a) : ((hidden = true), Promise.resolve(null)))) as never);
    try {
      const second = await taquillaSale(saleRequest(body));
      expect(second.status).toBe(200);
      const data = await second.json();
      expect(data.orderId).toBe(orderId);
      expect(data.tickets).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.order.count({ where: { idempotencyKey } })).toBe(1);
    expect(await prisma.ticket.count({ where: { orderId } })).toBe(1);
  });

  // AUDIT: onlineSalesClosed solo debe cerrar la compra ONLINE (ver
  // app/api/orders/route.ts) — la venta en taquilla tiene que seguir
  // funcionando con normalidad, es justo el caso de uso que motiva el flag
  // (aforo real disponible, pero solo se vende en persona el día del evento).
  it('sigue vendiendo con normalidad aunque el evento tenga la venta online cerrada', async () => {
    const closedEvent = await createTestEvent({ onlineSalesClosed: true });
    const closedTicketType = await createTicketType(closedEvent.id, { maxQuantity: 10 });

    try {
      const res = await taquillaSale(
        saleRequest({
          eventId: closedEvent.id,
          buyerName: 'Venta',
          buyerLastName: 'Presencial',
          buyerEmail: '',
          items: [{ ticketTypeId: closedTicketType.id, quantity: 1 }],
          paymentMethod: 'cash',
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      const order = await prisma.order.findUnique({ where: { id: data.orderId } });
      expect(order?.channel).toBe('TAQUILLA');
      expect(order?.status).toBe('COMPLETED');
    } finally {
      await cleanupTestEvent(closedEvent.id);
    }
  });

  // H-080: la taquilla vendía (y emitía QR) sobre eventos cancelados, terminados o sin publicar, y una cantidad no numérica daba NaN y acababa en 500.
  it.each(['CANCELLED', 'FINISHED', 'DRAFT'] as const)('no vende en un evento %s: 409 y ningún pedido', async (status) => {
    const closed = await createTestEvent({ status });
    const type = await createTicketType(closed.id, { maxQuantity: 10 });
    try {
      const res = await taquillaSale(saleRequest({ eventId: closed.id, buyerName: 'Nadie', items: [{ ticketTypeId: type.id, quantity: 1 }], paymentMethod: 'cash' }));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('event_not_open');
      expect(await prisma.order.count({ where: { eventId: closed.id } })).toBe(0);
    } finally {
      await cleanupTestEvent(closed.id);
    }
  });

  it('una cantidad no numérica, cero o negativa se rechaza con 400 en vez de dar NaN', async () => {
    for (const quantity of ['abc', 0, -3, '1.5x', 100_000]) {
      const res = await taquillaSale(saleRequest({ eventId: event.id, buyerName: 'Cantidad', items: [{ ticketTypeId: ticketType.id, quantity }], paymentMethod: 'cash' }));
      expect(res.status, String(quantity)).toBe(400);
    }
    expect(await prisma.order.count({ where: { eventId: event.id, buyerName: 'Cantidad' } })).toBe(0);
  });

  it('un tipo de entrada desactivado no se vende', async () => {
    const off = await createTicketType(event.id, { maxQuantity: 10 });
    await prisma.ticketType.update({ where: { id: off.id }, data: { isActive: false } });
    const res = await taquillaSale(saleRequest({ eventId: event.id, buyerName: 'Inactivo', items: [{ ticketTypeId: off.id, quantity: 1 }], paymentMethod: 'cash' }));
    expect(res.status).toBe(400);
    expect(await prisma.order.count({ where: { eventId: event.id, buyerName: 'Inactivo' } })).toBe(0);
  });
});
