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

  // M6: el estado de cobro normalizado permite liberar sin esperar 24 h lo que ya no se puede pagar (EXPIRED) y SOLO eso.
  it('libera enseguida un pedido cuya sesión de pago ya ha CADUCADO (no hace falta esperar 24 h)', async () => {
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: 0 } });
    const paymentId = `chk-expired-${Date.now()}`;
    const order = await createOrderAt(event.id, ticketType.id, paymentId, new Date(Date.now() - 5 * 60_000));
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: { increment: 1 } } });
    vi.stubGlobal('fetch', mockSumUpFetch({ [paymentId]: 'EXPIRED' }));

    const json = await (await reconcilePayments(cronRequest(TEST_SECRET))).json();
    expect(json.released).toBeGreaterThanOrEqual(1);
    expect((await prisma.order.findUnique({ where: { id: order.id } }))?.status).toBe('CANCELLED');
    expect((await prisma.ticketType.findUnique({ where: { id: ticketType.id } }))?.soldCount).toBe(0);
  });

  it.each(['FAILED', 'UNKNOWN_STATUS'])('NO libera un pedido reciente cuya pasarela dice %s (puede reintentarse)', async (status) => {
    const paymentId = `chk-${status}-${Date.now()}`;
    const order = await createOrderAt(event.id, ticketType.id, paymentId, new Date(Date.now() - 5 * 60_000));
    vi.stubGlobal('fetch', mockSumUpFetch({ [paymentId]: status }));

    await reconcilePayments(cronRequest(TEST_SECRET));
    expect((await prisma.order.findUnique({ where: { id: order.id } }))?.status).toBe('PENDING');
  });

  it('en la tienda también: caducado libera el stock y el pedido; fallido no', async () => {
    const product = await prisma.product.create({ data: { name: 'Cron', slug: `cron-${Date.now()}`, price: 10, variants: { create: { size: 'M', color: '', stock: 4 } } } });
    const mk = async (paymentId: string) =>
      prisma.shopOrder.update({
        where: { id: (await prisma.shopOrder.create({ data: { buyerName: 'C', buyerEmail: 'c@example.com', shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 10, paymentProvider: 'sumup', paymentId, status: 'PENDING', items: { create: { productId: product.id, quantity: 1, unitPrice: 10, size: 'M', color: '' } } } })).id },
        data: { createdAt: new Date(Date.now() - 5 * 60_000) },
      });
    const expired = await mk(`shop-exp-${Date.now()}`);
    const failed = await mk(`shop-fail-${Date.now()}`);
    vi.stubGlobal('fetch', mockSumUpFetch({ [expired.paymentId!]: 'EXPIRED', [failed.paymentId!]: 'FAILED' }));
    try {
      await reconcilePayments(cronRequest(TEST_SECRET));
      expect((await prisma.shopOrder.findUnique({ where: { id: expired.id } }))?.status).toBe('CANCELLED');
      expect((await prisma.shopOrder.findUnique({ where: { id: failed.id } }))?.status).toBe('PENDING');
    } finally {
      await prisma.shopOrder.deleteMany({ where: { id: { in: [expired.id, failed.id] } } });
      await prisma.product.delete({ where: { id: product.id } });
    }
  });

  // M7: cola justa. Con `createdAt asc` a secas, los 50 más antiguos se examinaban en cada pasada y el resto no se atendía nunca.
  describe('cola justa', () => {
    const pendingEverywhere = () =>
      vi.fn(async () => new Response(JSON.stringify({ status: 'PENDING' }), { status: 200 }));

    it('sella reconcileCheckedAt y reconcileAttempts en los examinados sin tocar su estado', async () => {
      const paymentId = `chk-stamp-${Date.now()}`;
      const order = await createOrderAt(event.id, ticketType.id, paymentId, new Date(Date.now() - 5 * 60_000));
      expect(order.reconcileCheckedAt).toBeNull();
      expect(order.reconcileAttempts).toBe(0);
      vi.stubGlobal('fetch', mockSumUpFetch({ [paymentId]: 'PENDING' }));

      await reconcilePayments(cronRequest(TEST_SECRET));
      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.status).toBe('PENDING');
      expect(after?.reconcileAttempts).toBe(1);
      expect(after?.reconcileCheckedAt).toBeInstanceOf(Date);
    });

    it('también sella los que dan error en la pasarela (no se quedan en cabeza para siempre)', async () => {
      const paymentId = `chk-err-${Date.now()}`;
      const order = await createOrderAt(event.id, ticketType.id, paymentId, new Date(Date.now() - 5 * 60_000));
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('pasarela caída'); }));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const json = await (await reconcilePayments(cronRequest(TEST_SECRET))).json();
      vi.restoreAllMocks();
      expect(json.errors).toBeGreaterThanOrEqual(1);
      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.status).toBe('PENDING');
      expect(after?.reconcileAttempts).toBe(1);
    });

    it('60 pedidos pendientes y 50 por pasada: la segunda pasada atiende a los 10 que la primera dejó fuera', async () => {
      const stamp = Date.now();
      // Más antiguos que el resto de pedidos de este fichero: son los que primero cogería un orden solo por antigüedad.
      const createdAt = new Date(Date.now() - 30 * 60_000);
      const ids = Array.from({ length: 60 }, (_, i) => `fair-${stamp}-${String(i).padStart(2, '0')}`);
      await prisma.order.createMany({
        data: ids.map((paymentId, i) => ({
          id: `ord-${paymentId}`, eventId: event.id, buyerName: 'Cola', buyerLastName: 'Justa', buyerEmail: `fair-${i}@example.com`,
          totalAmount: 10, paymentProvider: 'sumup', paymentId, status: 'PENDING' as const,
          createdAt: new Date(createdAt.getTime() + i * 1000),
        })),
      });
      const mine = ids.map((id) => `ord-${id}`);
      const attempts = async () => new Map((await prisma.order.findMany({ where: { id: { in: mine } } })).map((o) => [o.id, o.reconcileAttempts]));
      try {
        vi.stubGlobal('fetch', pendingEverywhere());
        await reconcilePayments(cronRequest(TEST_SECRET));
        const first = await attempts();
        const examinedFirst = mine.filter((id) => first.get(id) === 1);
        const leftOut = mine.filter((id) => first.get(id) === 0);
        expect(examinedFirst.length).toBeLessThanOrEqual(50);
        expect(leftOut.length).toBeGreaterThanOrEqual(10);

        await reconcilePayments(cronRequest(TEST_SECRET));
        const second = await attempts();
        // Los que quedaron fuera pasan por delante de los ya examinados.
        for (const id of leftOut.slice(0, 10)) expect(second.get(id), id).toBe(1);
        expect(mine.every((id) => (second.get(id) ?? 0) <= 2)).toBe(true);
        // Nada se ha liberado ni completado: sigue todo PENDING.
        expect(await prisma.order.count({ where: { id: { in: mine }, status: 'PENDING' } })).toBe(60);
      } finally {
        await prisma.order.deleteMany({ where: { id: { in: mine } } });
      }
    });
  });
});
