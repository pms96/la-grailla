import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';

function orderRequest(body: unknown, ip: string) {
  return new Request('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('POST /api/orders', () => {
  let originalGateway: string | null;
  let originalCommission: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    // Pasarela "mock" para que el pedido se complete de forma determinista
    // en el propio POST, sin depender de Stripe/SumUp reales. Comisión a 0
    // para que el total esperado no dependa de la configuración real vigente.
    originalGateway = await getAndSetConfig('payment_gateway', 'mock');
    originalCommission = await getAndSetConfig('commission_percentage', '0');
    event = await createTestEvent();
  });

  afterAll(async () => {
    await restoreConfig('payment_gateway', originalGateway);
    await restoreConfig('commission_percentage', originalCommission);
    await cleanupTestEvent(event.id);
  });

  it('crea el pedido, marca las entradas como VALID y descuenta stock', async () => {
    const ticketType = await createTicketType(event.id, { maxQuantity: 5, price: 12.5 });

    const res = await createOrder(
      orderRequest(
        {
          eventId: event.id,
          buyerName: 'Ana',
          buyerLastName: 'García',
          buyerEmail: 'ana@example.com',
          items: [{ ticketTypeId: ticketType.id, quantity: 2 }],
        },
        '203.0.113.1'
      )
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.totalAmount).toBeCloseTo(25);

    const order = await prisma.order.findUnique({ where: { id: json.orderId }, include: { tickets: true } });
    expect(order?.status).toBe('COMPLETED');
    expect(order?.tickets).toHaveLength(2);
    expect(order?.tickets.every((t) => t.status === 'VALID')).toBe(true);

    const updatedTicketType = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(updatedTicketType?.soldCount).toBe(2);
  });

  it('rechaza un ticketTypeId que no existe', async () => {
    const res = await createOrder(
      orderRequest(
        {
          eventId: event.id,
          buyerName: 'Ana',
          buyerLastName: 'García',
          buyerEmail: 'ana@example.com',
          items: [{ ticketTypeId: 'no-existe', quantity: 1 }],
        },
        '203.0.113.2'
      )
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no válido/i);
  });

  it('rechaza el pedido cuando no queda stock suficiente', async () => {
    const ticketType = await createTicketType(event.id, { maxQuantity: 3 });

    const res = await createOrder(
      orderRequest(
        {
          eventId: event.id,
          buyerName: 'Ana',
          buyerLastName: 'García',
          buyerEmail: 'ana@example.com',
          items: [{ ticketTypeId: ticketType.id, quantity: 4 }],
        },
        '203.0.113.3'
      )
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no hay suficientes entradas/i);

    const unchanged = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(unchanged?.soldCount).toBe(0);
  });

  it('no vende más entradas que el stock disponible bajo peticiones concurrentes', async () => {
    // Simula el momento crítico: 10 compradores piden 2 entradas cada uno
    // (20 en total) contra un tipo con solo 5 disponibles, todos a la vez.
    // Antes del lock por evento, el patrón "leer stock, decidir, escribir"
    // dejaba pasar a varios de golpe porque todos leían el mismo stock
    // desactualizado. Con el fix, como mucho deben completarse 2 pedidos
    // (2+2=4 de 5 huecos; el tercero ya no cabe).
    const ticketType = await createTicketType(event.id, { maxQuantity: 5 });
    const CONCURRENT_BUYERS = 10;

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_BUYERS }, (_, i) =>
        createOrder(
          orderRequest(
            {
              eventId: event.id,
              buyerName: 'Concurrente',
              buyerLastName: `${i}`,
              buyerEmail: `concurrente-${i}@example.com`,
              items: [{ ticketTypeId: ticketType.id, quantity: 2 }],
            },
            `203.0.113.10${i}`
          )
        )
      )
    );

    const statuses = await Promise.all(responses.map((r) => r.json().then((json) => ({ status: r.status, json }))));
    const succeeded = statuses.filter((s) => s.status === 200);
    const rejected = statuses.filter((s) => s.status === 400);

    expect(succeeded.length + rejected.length).toBe(CONCURRENT_BUYERS);
    // Lo importante no es cuántos ganan la carrera, sino que NUNCA se venda
    // de más: el stock final tiene que cuadrar exactamente con lo vendido.
    const updatedTicketType = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(updatedTicketType?.soldCount).toBeLessThanOrEqual(5);
    expect(updatedTicketType?.soldCount).toBe(succeeded.length * 2);

    const ticketsCreated = await prisma.ticket.count({ where: { ticketTypeId: ticketType.id, status: 'VALID' } });
    expect(ticketsCreated).toBe(updatedTicketType?.soldCount);
  });

  it('rechaza pedidos sobre un evento no publicado', async () => {
    const draftEvent = await createTestEvent();
    await prisma.event.update({ where: { id: draftEvent.id }, data: { status: 'DRAFT' } });
    const ticketType = await createTicketType(draftEvent.id);

    try {
      const res = await createOrder(
        orderRequest(
          {
            eventId: draftEvent.id,
            buyerName: 'Ana',
            buyerLastName: 'García',
            buyerEmail: 'ana@example.com',
            items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          },
          '203.0.113.4'
        )
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/evento no disponible/i);
    } finally {
      await cleanupTestEvent(draftEvent.id);
    }
  });

  it('con la misma idempotencyKey no crea un segundo pedido', async () => {
    // Simula un doble clic o un reintento de red: dos peticiones con
    // exactamente la misma clave para la misma intención de compra.
    const ticketType = await createTicketType(event.id, { maxQuantity: 5 });
    const idempotencyKey = `idem-${Date.now()}`;
    const body = {
      eventId: event.id,
      buyerName: 'Ana',
      buyerLastName: 'García',
      buyerEmail: 'ana-idem@example.com',
      items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
      idempotencyKey,
    };

    const first = await createOrder(orderRequest(body, '203.0.113.20'));
    const firstJson = await first.json();
    expect(first.status).toBe(200);
    expect(firstJson.success).toBe(true);

    const second = await createOrder(orderRequest(body, '203.0.113.20'));
    const secondJson = await second.json();
    expect(second.status).toBe(200);
    expect(secondJson.success).toBe(true);
    expect(secondJson.orderId).toBe(firstJson.orderId);

    const orders = await prisma.order.count({ where: { idempotencyKey } });
    expect(orders).toBe(1);

    const updatedTicketType = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(updatedTicketType?.soldCount).toBe(1);
  });

  it('con la misma idempotencyKey bajo peticiones concurrentes solo crea un pedido', async () => {
    // El P2002 del UNIQUE de Postgres es la red de seguridad para el caso
    // que la comprobación previa (findUnique) no puede cerrar por sí sola:
    // dos peticiones que llegan tan cerca en el tiempo que ninguna ve
    // todavía el pedido de la otra.
    const ticketType = await createTicketType(event.id, { maxQuantity: 5 });
    const idempotencyKey = `idem-concurrent-${Date.now()}`;
    const body = {
      eventId: event.id,
      buyerName: 'Ana',
      buyerLastName: 'García',
      buyerEmail: 'ana-idem-concurrente@example.com',
      items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
      idempotencyKey,
    };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => createOrder(orderRequest(body, '203.0.113.21')))
    );
    const jsons = await Promise.all(responses.map((r) => r.json()));

    expect(jsons.every((j) => j.success === true)).toBe(true);
    const orderIds = new Set(jsons.map((j) => j.orderId));
    expect(orderIds.size).toBe(1);

    const orders = await prisma.order.count({ where: { idempotencyKey } });
    expect(orders).toBe(1);
  });

  it('libera la idempotencyKey si el pedido se cancela, permitiendo un reintento real', async () => {
    // Cuando la pasarela real falla al crear la sesión de cobro, el pedido
    // se cancela y su idempotencyKey se limpia — un reintento del comprador
    // con la MISMA clave debe generar un pedido nuevo, no que se le devuelva
    // el pedido cancelado como si fuera un éxito.
    const ticketType = await createTicketType(event.id, { maxQuantity: 5 });
    const idempotencyKey = `idem-cancelled-${Date.now()}`;

    const cancelledOrder = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Ana', buyerLastName: 'García', buyerEmail: 'ana-cancelada@example.com',
        totalAmount: 10, status: 'CANCELLED', idempotencyKey: null,
      },
    });
    expect(cancelledOrder.idempotencyKey).toBeNull();

    const res = await createOrder(
      orderRequest(
        {
          eventId: event.id,
          buyerName: 'Ana',
          buyerLastName: 'García',
          buyerEmail: 'ana-cancelada@example.com',
          items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          idempotencyKey,
        },
        '203.0.113.22'
      )
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.orderId).not.toBe(cancelledOrder.id);

    const newOrder = await prisma.order.findUnique({ where: { id: json.orderId } });
    expect(newOrder?.status).toBe('COMPLETED');
  });

  it('rechaza el pedido cuando supera el aforo del evento', async () => {
    const smallEvent = await createTestEvent({ maxCapacity: 1 });
    const ticketType = await createTicketType(smallEvent.id, { maxQuantity: 10 });

    try {
      // Ocupa el único hueco de aforo con una entrada ya emitida.
      await prisma.order.create({
        data: {
          eventId: smallEvent.id,
          buyerName: 'Ya', buyerLastName: 'Vendido', buyerEmail: 'ya@example.com',
          totalAmount: 10, status: 'COMPLETED',
          tickets: { create: { eventId: smallEvent.id, ticketTypeId: ticketType.id, qrCode: `QR-${Date.now()}`, holderName: 'Ya Vendido', status: 'VALID' } },
        },
      });

      const res = await createOrder(
        orderRequest(
          {
            eventId: smallEvent.id,
            buyerName: 'Ana',
            buyerLastName: 'García',
            buyerEmail: 'ana@example.com',
            items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          },
          '203.0.113.5'
        )
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/aforo completo/i);
    } finally {
      await cleanupTestEvent(smallEvent.id);
    }
  });
});
