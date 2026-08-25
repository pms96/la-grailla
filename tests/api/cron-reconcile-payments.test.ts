import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as reconcilePayments } from '@/app/api/cron/reconcile-payments/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';

// SumUp es la única pasarela soportada sin webhook — un pedido pagado con
// SumUp solo se confirmaba antes si el comprador volvía a /confirmacion.
// Este cron es la red de seguridad que reconcilia lo que se quedó en PENDING
// porque el comprador nunca volvió (cerró la pestaña, perdió la conexión...).
function cronRequest(secret: string | null) {
  return new Request('http://localhost/api/cron/reconcile-payments', {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  });
}

function mockSumUpFetch(statusByCheckoutId: Record<string, string>) {
  return vi.fn(async (url: string | URL) => {
    const urlStr = url.toString();
    const id = urlStr.split('/').pop();
    const status = id ? statusByCheckoutId[id] : undefined;
    if (!status) {
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }
    return new Response(JSON.stringify({ status }), { status: 200 });
  });
}

async function createOrderAt(eventId: string, ticketTypeId: string, paymentId: string, createdAt: Date) {
  const order = await prisma.order.create({
    data: {
      eventId, buyerName: 'Cron', buyerLastName: 'Test', buyerEmail: `cron-${paymentId}@example.com`,
      totalAmount: 10, paymentProvider: 'sumup', paymentId, status: 'PENDING',
      tickets: { create: { eventId, ticketTypeId, qrCode: `QR-CRON-${paymentId}`, holderName: 'Cron Test', status: 'PENDING' } },
    },
  });
  // createdAt no es asignable en el create (Prisma la fuerza a now()) — se
  // ajusta aparte para simular pedidos "viejos" sin esperar de verdad.
  return prisma.order.update({ where: { id: order.id }, data: { createdAt } });
}

describe('GET /api/cron/reconcile-payments', () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const TEST_SECRET = 'test-cron-secret';
  let originalApiKey: string | null;
  let originalMerchantCode: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;

  beforeAll(async () => {
    process.env.CRON_SECRET = TEST_SECRET;
    originalApiKey = await getAndSetConfig('sumup_api_key', 'test-key');
    originalMerchantCode = await getAndSetConfig('sumup_merchant_code', 'MTEST');
    event = await createTestEvent();
    ticketType = await createTicketType(event.id, { maxQuantity: 20 });
  });

  afterAll(async () => {
    process.env.CRON_SECRET = originalCronSecret;
    await restoreConfig('sumup_api_key', originalApiKey);
    await restoreConfig('sumup_merchant_code', originalMerchantCode);
    await cleanupTestEvent(event.id);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rechaza sin el secreto correcto', async () => {
    const resNoAuth = await reconcilePayments(cronRequest(null));
    expect(resNoAuth.status).toBe(401);

    const resWrongAuth = await reconcilePayments(cronRequest('wrong'));
    expect(resWrongAuth.status).toBe(401);
  });

  it('confirma un pedido pendiente cuya pasarela ya reporta el pago como PAID', async () => {
    const paymentId = `chk-paid-${Date.now()}`;
    const order = await createOrderAt(event.id, ticketType.id, paymentId, new Date(Date.now() - 5 * 60_000));
    vi.stubGlobal('fetch', mockSumUpFetch({ [paymentId]: 'PAID' }));

    const res = await reconcilePayments(cronRequest(TEST_SECRET));
    const json = await res.json();
    expect(json.completed).toBeGreaterThanOrEqual(1);

    const updated = await prisma.order.findUnique({ where: { id: order.id }, include: { tickets: true } });
    expect(updated?.status).toBe('COMPLETED');
    expect(updated?.tickets.every((t) => t.status === 'VALID')).toBe(true);
  });

  it('deja en PENDING un pedido cuya pasarela todavía no reporta el pago', async () => {
    const paymentId = `chk-pending-${Date.now()}`;
    const order = await createOrderAt(event.id, ticketType.id, paymentId, new Date(Date.now() - 5 * 60_000));
    vi.stubGlobal('fetch', mockSumUpFetch({ [paymentId]: 'PENDING' }));

    await reconcilePayments(cronRequest(TEST_SECRET));

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe('PENDING');
  });

  it('libera un pedido PENDING más antiguo que 24h si la pasarela no confirma el pago', async () => {
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: 0 } });
    const paymentId = `chk-abandon-${Date.now()}`;
    const order = await createOrderAt(
      event.id,
      ticketType.id,
      paymentId,
      new Date(Date.now() - 25 * 60 * 60_000)
    );
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: { increment: 1 } } });
    vi.stubGlobal('fetch', mockSumUpFetch({ [paymentId]: 'PENDING' }));

    const res = await reconcilePayments(cronRequest(TEST_SECRET));
    const json = await res.json();
    expect(json.released).toBeGreaterThanOrEqual(1);

    const updated = await prisma.order.findUnique({ where: { id: order.id }, include: { tickets: true } });
    expect(updated?.status).toBe('CANCELLED');
    expect(updated?.tickets.every((t) => t.status === 'CANCELLED')).toBe(true);

    const tt = await prisma.ticketType.findUnique({ where: { id: ticketType.id } });
    expect(tt?.soldCount).toBe(0);
  });
});
