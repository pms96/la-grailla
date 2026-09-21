import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
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
    await prisma.user.delete({ where: { id: staffUserId } }).catch(() => {});
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
});
