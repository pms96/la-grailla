// AUDIT: PAY-03 — la pasarela "mock" por defecto puede completar ventas
// reales sin cobrar. Si se despliega a producción sin configurar Stripe/SumUp
// en /admin/configuracion (o si "payment_gateway" queda en "mock" por error),
// el checkout completa el pedido y marca las entradas como VALID sin cobrar
// nada. Severidad: Alta.
//
// Este test fuerza NODE_ENV=production para la duración del test y confirma
// que el checkout se bloquea con un error explícito en vez de completarse
// gratis. Restaura NODE_ENV al terminar para no afectar al resto de la suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../../tests/helpers/fixtures';

function orderRequest(body: unknown, ip: string) {
  return new Request('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('AUDIT — la pasarela mock no debe completar ventas en producción', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let originalGateway: string | null;
  let originalNodeEnv: string | undefined;

  beforeAll(async () => {
    originalGateway = await getAndSetConfig('payment_gateway', 'mock');
    event = await createTestEvent();
    originalNodeEnv = process.env.NODE_ENV;
    // @ts-expect-error NODE_ENV es de solo lectura en el tipo, pero sí se puede reasignar en runtime.
    process.env.NODE_ENV = 'production';
  });

  afterAll(async () => {
    // @ts-expect-error idem — restaurar el valor real de vuelta.
    process.env.NODE_ENV = originalNodeEnv;
    await restoreConfig('payment_gateway', originalGateway);
    await cleanupTestEvent(event.id);
  });

  it('rechaza el pedido en vez de completarlo gratis con NODE_ENV=production y gateway=mock', async () => {
    const ticketType = await createTicketType(event.id, { maxQuantity: 5, price: 12.5 });

    const res = await createOrder(
      orderRequest(
        {
          eventId: event.id,
          buyerName: 'Producción',
          buyerLastName: 'Falsa',
          buyerEmail: 'produccion-mock-audit@example.com',
          items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
        },
        '203.0.113.77'
      )
    );

    // Comportamiento esperado tras el fix: la creación del pedido falla (no
    // hay pedido COMPLETED gratis) en vez de devolver 200 con entradas VALID.
    expect(res.status).not.toBe(200);

    const orders = await prisma.order.findMany({ where: { eventId: event.id, buyerEmail: 'produccion-mock-audit@example.com' } });
    const completedFree = orders.find((o) => o.status === 'COMPLETED');
    expect(completedFree).toBeUndefined();
  });
});
