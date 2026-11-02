import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { calculateCommission } from '@/lib/pricing';

function orderRequest(body: unknown, ip: string) {
  return new Request('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ acceptedTerms: true, ...(body as object) }),
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

  // AUDIT (nueva funcionalidad): el checkout público ahora muestra "gastos
  // de distribución" junto al precio antes de pagar, calculado con la misma
  // fórmula que aquí — este test confirma que lo que de verdad se cobra
  // (commission + totalAmount) sigue coincidiendo con esa fórmula tras
  // extraerla a lib/pricing.ts.
  it('añade la comisión configurada al total cobrado', async () => {
    const originalCommissionForTest = await getAndSetConfig('commission_percentage', '5');
    try {
      const ticketType = await createTicketType(event.id, { maxQuantity: 5, price: 20 });

      const res = await createOrder(
        orderRequest(
          {
            eventId: event.id,
            buyerName: 'Comisión',
            buyerLastName: 'Test',
            buyerEmail: 'comision-test@example.com',
            items: [{ ticketTypeId: ticketType.id, quantity: 2 }],
          },
          '203.0.113.9'
        )
      );
      const json = await res.json();
      expect(res.status).toBe(200);

      const expectedCommission = calculateCommission(40, 5);
      expect(expectedCommission).toBeCloseTo(2);
      expect(json.totalAmount).toBeCloseTo(40 + expectedCommission);

      const order = await prisma.order.findUnique({ where: { id: json.orderId } });
      expect(order?.commission).toBeCloseTo(2);
      expect(order?.totalAmount).toBeCloseTo(42);
    } finally {
      await restoreConfig('commission_percentage', originalCommissionForTest);
    }
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

  // H-214: el comprador va a la pasarela, vuelve atrás (la clave del navegador sigue viva), cambia la selección y paga de nuevo: el servidor devolvía el pedido ANTIGUO
  // «sin comprobar más campos» y se pagaba lo que ya no quería. Ahora una clave reutilizada con otra selección es un 409 y no toca nada.
  it('H-214: la misma idempotencyKey con OTRA selección (cantidad, tipo o email) da 409 y no devuelve el pedido antiguo', async () => {
    const ticketType = await createTicketType(event.id, { maxQuantity: 8 });
    const idempotencyKey = `idem-cambio-${Date.now()}`;
    const base = { eventId: event.id, buyerName: 'Ana', buyerLastName: 'García', buyerEmail: 'ana-cambio@example.com', idempotencyKey };

    const first = await createOrder(orderRequest({ ...base, items: [{ ticketTypeId: ticketType.id, quantity: 2 }] }, '203.0.113.30'));
    const firstJson = await first.json();
    expect(first.status).toBe(200);

    const masCantidad = await createOrder(orderRequest({ ...base, items: [{ ticketTypeId: ticketType.id, quantity: 4 }] }, '203.0.113.30'));
    expect(masCantidad.status).toBe(409);
    const masCantidadJson = await masCantidad.json();
    expect(masCantidadJson.code).toBe('idempotency_mismatch');
    expect(masCantidadJson.orderId).toBeUndefined();
    expect(masCantidadJson.checkoutUrl).toBeUndefined();

    const otroEmail = await createOrder(orderRequest({ ...base, buyerEmail: 'otra-persona@example.com', items: [{ ticketTypeId: ticketType.id, quantity: 2 }] }, '203.0.113.30'));
    expect(otroEmail.status).toBe(409);

    // El pedido original sigue intacto y no se creó ninguno nuevo.
    expect(await prisma.order.count({ where: { idempotencyKey } })).toBe(1);
    expect((await prisma.ticketType.findUnique({ where: { id: ticketType.id } }))?.soldCount).toBe(2);

    // El mismo intento exacto (reintento de red) sigue reconociéndose.
    const mismo = await createOrder(orderRequest({ ...base, items: [{ ticketTypeId: ticketType.id, quantity: 2 }] }, '203.0.113.30'));
    expect(mismo.status).toBe(200);
    expect((await mismo.json()).orderId).toBe(firstJson.orderId);
  });

  // H-215: tras 20 min en la sala de espera, la pantalla pintaba el precio de cuando cargó. Ahora manda el total que ve y, si el servidor (con los precios frescos y el cerrojo
  // tomado) saca otro, responde 409 con las cifras nuevas y NO crea pedido ni toca el stock. Igual que en la tienda (H-132).
  describe('H-215: el total que se cobra es el que se vio', () => {
    it('con el total esperado correcto crea el pedido; sin total esperado (cliente antiguo) cobra el precio vigente', async () => {
      const ticketType = await createTicketType(event.id, { maxQuantity: 8, price: 10 });
      const ok = await createOrder(orderRequest({ eventId: event.id, buyerName: 'Ana', buyerLastName: 'García', buyerEmail: 'ana-total@example.com', items: [{ ticketTypeId: ticketType.id, quantity: 2 }], expectedTotalCents: 2000 }, '203.0.113.40'));
      expect(ok.status).toBe(200);
      const sin = await createOrder(orderRequest({ eventId: event.id, buyerName: 'Ana', buyerLastName: 'García', buyerEmail: 'ana-total2@example.com', items: [{ ticketTypeId: ticketType.id, quantity: 1 }] }, '203.0.113.40'));
      expect(sin.status).toBe(200);
    });

    it('si el precio cambió entre medias: 409 `price_changed` con el total y los precios nuevos, sin pedido y sin tocar el stock', async () => {
      const ticketType = await createTicketType(event.id, { maxQuantity: 8, price: 10 });
      await prisma.ticketType.update({ where: { id: ticketType.id }, data: { price: 12 } });
      const res = await createOrder(orderRequest({ eventId: event.id, buyerName: 'Ana', buyerLastName: 'García', buyerEmail: 'ana-sube@example.com', items: [{ ticketTypeId: ticketType.id, quantity: 2 }], expectedTotalCents: 2000 }, '203.0.113.41'));
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.code).toBe('price_changed');
      expect(data.totalAmount).toBe(24);
      expect(data.error).toContain('24,00');
      expect(data.orderId).toBeUndefined();
      expect(await prisma.order.count({ where: { buyerEmail: 'ana-sube@example.com' } })).toBe(0);
      expect((await prisma.ticketType.findUnique({ where: { id: ticketType.id } }))?.soldCount).toBe(0);
    });

    it('también si bajó: el comprador ve la cifra nueva antes de pagar', async () => {
      const ticketType = await createTicketType(event.id, { maxQuantity: 8, price: 10 });
      await prisma.ticketType.update({ where: { id: ticketType.id }, data: { price: 8 } });
      const res = await createOrder(orderRequest({ eventId: event.id, buyerName: 'Ana', buyerLastName: 'García', buyerEmail: 'ana-baja@example.com', items: [{ ticketTypeId: ticketType.id, quantity: 2 }], expectedTotalCents: 2000 }, '203.0.113.42'));
      expect(res.status).toBe(409);
      expect((await res.json()).totalAmount).toBe(16);
    });

    it('un total esperado negativo o no entero es una petición mal formada (400)', async () => {
      const ticketType = await createTicketType(event.id, { maxQuantity: 8, price: 10 });
      for (const bad of [-1, 20.5]) {
        const res = await createOrder(orderRequest({ eventId: event.id, buyerName: 'Ana', buyerLastName: 'García', buyerEmail: 'ana-mal@example.com', items: [{ ticketTypeId: ticketType.id, quantity: 1 }], expectedTotalCents: bad }, '203.0.113.43'));
        expect(res.status).toBe(400);
      }
    });
  });

  // H-232: `getConfig` traga el error de BD y devolvía el defecto '0': un fallo puntual de lectura creaba el pedido con comisión 0 en vez de fallar (ingreso perdido en silencio).
  it('H-232: si falla la lectura de la comisión, NO se crea el pedido con comisión 0', async () => {
    const ticketType = await createTicketType(event.id, { maxQuantity: 8, price: 10 });
    const real = prisma.appConfig.findUnique.bind(prisma.appConfig) as (args: { where: { key: string } }) => Promise<unknown>;
    const spy = vi.spyOn(prisma.appConfig, 'findUnique').mockImplementation(((args: { where: { key: string } }) => {
      if (args.where.key === 'commission_percentage') return Promise.reject(new Error('Connection terminated unexpectedly'));
      return real(args);
    }) as never);
    try {
      const res = await createOrder(orderRequest({ eventId: event.id, buyerName: 'Ana', buyerLastName: 'García', buyerEmail: 'ana-comision@example.com', items: [{ ticketTypeId: ticketType.id, quantity: 1 }] }, '203.0.113.44'));
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await prisma.order.count({ where: { buyerEmail: 'ana-comision@example.com' } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
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

  // AUDIT: /api/orders solo comprobaba event.status !== 'PUBLISHED', nunca la
  // fecha del evento — un evento PUBLISHED con fecha pasada seguía vendiendo
  // entradas indefinidamente. Severidad: Alto.
  it('rechaza el pedido cuando el evento ya ha finalizado', async () => {
    const pastEvent = await createTestEvent({ date: new Date('2025-09-26T19:00:00.000Z') });
    const ticketType = await createTicketType(pastEvent.id);

    try {
      const res = await createOrder(
        orderRequest(
          {
            eventId: pastEvent.id,
            buyerName: 'Ana',
            buyerLastName: 'García',
            buyerEmail: 'ana-evento-pasado@example.com',
            items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          },
          '203.0.113.6'
        )
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/finalizado/i);

      const updatedTicketType = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
      expect(updatedTicketType?.soldCount).toBe(0);
    } finally {
      await cleanupTestEvent(pastEvent.id);
    }
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

  // AUDIT: onlineSalesClosed permite dejar un evento publicado (visible en
  // /eventos) pero cerrado a compra online, para venderlo solo en taquilla —
  // este endpoint es justo el que hay que bloquear server-side, no solo
  // ocultar el botón en la web, para que nadie se lo salte llamando a la API.
  it('rechaza el pedido si el evento tiene la venta online cerrada (solo taquilla)', async () => {
    const taquillaOnlyEvent = await createTestEvent({ onlineSalesClosed: true });
    const ticketType = await createTicketType(taquillaOnlyEvent.id, { maxQuantity: 10 });

    try {
      const res = await createOrder(
        orderRequest(
          {
            eventId: taquillaOnlyEvent.id,
            buyerName: 'Ana',
            buyerLastName: 'García',
            buyerEmail: 'ana@example.com',
            items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          },
          '203.0.113.6'
        )
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/cerradas/i);

      const orders = await prisma.order.findMany({ where: { eventId: taquillaOnlyEvent.id } });
      expect(orders).toHaveLength(0);
    } finally {
      await cleanupTestEvent(taquillaOnlyEvent.id);
    }
  });
});
