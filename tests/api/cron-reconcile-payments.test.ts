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
    vi.unstubAllEnvs(); // aunque un test falle antes de su `finally`, el lote o el presupuesto fijados no contaminan al siguiente
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

    it('responde 502 si todo lo examinado dio error y no hubo ni un avance (el disparador no la da por buena); 200 si no hubo errores', async () => {
      const paymentId = `chk-502-${Date.now()}`;
      await createOrderAt(event.id, ticketType.id, paymentId, new Date(Date.now() - 5 * 60_000));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('pasarela caída'); }));
      const failing = await reconcilePayments(cronRequest(TEST_SECRET));
      const failingBody = await failing.json();
      expect(failingBody.errors).toBeGreaterThanOrEqual(1);
      // Con avance (p. ej. un pedido viejo sin pasarela que sí se libera) sería 200: en una BD compartida con otros tests solo se fija la regla.
      const progressed = failingBody.completed + failingBody.released + failingBody.stillPending > 0;
      expect(failing.status).toBe(progressed ? 200 : 502);

      vi.stubGlobal('fetch', pendingEverywhere());
      const healthy = await reconcilePayments(cronRequest(TEST_SECRET));
      vi.restoreAllMocks();
      expect(healthy.status).toBe(200);
    });

    it('60 pedidos pendientes y 50 por pasada: la segunda pasada atiende a los 10 que la primera dejó fuera', async () => {
      vi.stubEnv('RECONCILE_GATEWAY_BATCH', '50'); // el lote por defecto es mayor (P1-13): aquí se fija en 50 para ejercitar la cola justa
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
        vi.unstubAllEnvs();
        await prisma.order.deleteMany({ where: { id: { in: mine } } });
      }
    });

    /** La BD de pruebas se comparte: los pedidos con pasarela que NO son de este test se marcan como ya examinados para que no ocupen huecos de la pasada. */
    const sealOthers = async (mine: string[], at = new Date()) => {
      const where = { status: 'PENDING' as const, paymentId: { not: null }, id: { notIn: mine } };
      await prisma.order.updateMany({ where, data: { reconcileCheckedAt: at } });
      await prisma.shopOrder.updateMany({ where, data: { reconcileCheckedAt: at } });
    };
    const ticketRows = (prefix: string, n: number, createdAt: Date) =>
      Array.from({ length: n }, (_, i) => ({
        id: `ord-${prefix}-${String(i).padStart(3, '0')}`, eventId: event.id, buyerName: 'Lote', buyerLastName: 'Grande', buyerEmail: `${prefix}-${i}@example.com`,
        totalAmount: 10, paymentProvider: 'sumup', paymentId: `${prefix}-${String(i).padStart(3, '0')}`, status: 'PENDING' as const, createdAt: new Date(createdAt.getTime() + i * 1000),
      }));
    const shopRows = (prefix: string, n: number, createdAt: Date) =>
      Array.from({ length: n }, (_, i) => ({
        id: `shp-${prefix}-${String(i).padStart(3, '0')}`, buyerName: 'Lote', buyerEmail: `${prefix}-${i}@example.com`, shippingAddress: 'x', shippingCity: 'x', shippingZip: '1',
        totalAmount: 10, paymentProvider: 'sumup', paymentId: `${prefix}-${String(i).padStart(3, '0')}`, status: 'PENDING' as const, createdAt: new Date(createdAt.getTime() + i * 1000),
      }));

    it('P1-13: por defecto una pasada examina 100 pedidos con pago en la pasarela por lista (no 50), y la siguiente atiende a los que quedaron fuera', async () => {
      vi.stubEnv('RECONCILE_GATEWAY_BATCH', ''); // el .env del desarrollador no debe cambiar el valor por defecto que se prueba
      const prefix = `big-${Date.now()}`;
      await prisma.order.createMany({ data: ticketRows(prefix, 130, new Date(Date.now() - 40 * 60_000)) });
      const mine = Array.from({ length: 130 }, (_, i) => `ord-${prefix}-${String(i).padStart(3, '0')}`);
      const attempts = async () => new Map((await prisma.order.findMany({ where: { id: { in: mine } } })).map((o) => [o.id, o.reconcileAttempts]));
      try {
        await sealOthers(mine);
        vi.stubGlobal('fetch', pendingEverywhere());
        await reconcilePayments(cronRequest(TEST_SECRET));
        const first = await attempts();
        const examinedFirst = mine.filter((id) => first.get(id) === 1);
        expect(examinedFirst).toHaveLength(100); // el valor por defecto, exacto
        const leftOut = mine.filter((id) => first.get(id) === 0);
        expect(leftOut).toHaveLength(30);
        await sealOthers(mine);
        await reconcilePayments(cronRequest(TEST_SECRET));
        const second = await attempts();
        for (const id of leftOut) expect(second.get(id), id).toBe(1); // los que quedaron fuera pasan por delante de los ya examinados
      } finally {
        await prisma.order.deleteMany({ where: { id: { in: mine } } });
      }
    });

    it('entradas y tienda se INTERCALAN en la cola: una pasada corta de tiempo no deja a la tienda sin examinar', async () => {
      const prefix = `il-${Date.now()}`;
      const old = new Date(Date.now() - 60 * 60_000);
      await prisma.order.createMany({ data: ticketRows(`${prefix}-t`, 12, old) });
      await prisma.shopOrder.createMany({ data: shopRows(`${prefix}-s`, 12, old) });
      const mineT = Array.from({ length: 12 }, (_, i) => `ord-${prefix}-t-${String(i).padStart(3, '0')}`);
      const mineS = Array.from({ length: 12 }, (_, i) => `shp-${prefix}-s-${String(i).padStart(3, '0')}`);
      const started: string[] = [];
      try {
        await sealOthers([...mineT, ...mineS]);
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
          const id = url.toString().split('/').pop() ?? '';
          if (id.startsWith(prefix)) started.push(id);
          return new Response(JSON.stringify({ status: 'PENDING' }), { status: 200 });
        }));
        await reconcilePayments(cronRequest(TEST_SECRET));
        // Un pedido viejo cuesta varias llamadas a la pasarela (verificar, cerrar, verificar): se cuentan pedidos distintos, en el orden en que aparecen.
        const distinct = [...new Set(started)];
        expect(distinct).toHaveLength(24); // sin recorte de tiempo se examinan todos
        // El primer grupo (5, concurrentes) ya mezcla las dos listas: con las entradas siempre delante serían 5 de entradas y 0 de tienda.
        const firstGroup = distinct.slice(0, 5);
        expect(firstGroup.filter((id) => id.includes('-t-')).length).toBeGreaterThanOrEqual(2);
        expect(firstGroup.filter((id) => id.includes('-s-')).length).toBeGreaterThanOrEqual(2);
      } finally {
        await prisma.order.deleteMany({ where: { id: { in: mineT } } });
        await prisma.shopOrder.deleteMany({ where: { id: { in: mineS } } });
      }
    });

    it('una pasarela COLGADA no alarga la pasada más allá del tope: se abandona la espera del grupo, lo no atendido sigue PENDING y se avisa con groupTimedOut', async () => {
      vi.stubEnv('RECONCILE_TIME_BUDGET_MS', '50');
      vi.stubEnv('RECONCILE_GROUP_GRACE_MS', '200');
      const prefix = `hung-${Date.now()}`;
      await prisma.order.createMany({ data: ticketRows(prefix, 12, new Date(Date.now() - 30 * 60_000)) });
      const mine = Array.from({ length: 12 }, (_, i) => `ord-${prefix}-${String(i).padStart(3, '0')}`);
      try {
        await sealOthers(mine);
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))); // no contesta nunca
        const started = Date.now();
        const res = await reconcilePayments(cronRequest(TEST_SECRET));
        const json = await res.json();
        expect(Date.now() - started).toBeLessThan(5_000); // sin el tope, esta llamada no terminaría
        expect(json.groupTimedOut).toBe(true);
        expect(json.deferred).toBeGreaterThanOrEqual(7);
        const rows = await prisma.order.findMany({ where: { id: { in: mine } } });
        expect(rows.every((o) => o.status === 'PENDING')).toBe(true); // nada se libera ni se completa sin saber lo que dice la pasarela
        expect(rows.filter((o) => o.reconcileAttempts === 1)).toHaveLength(5); // el grupo que se quedó esperando ya estaba sellado
        expect(rows.filter((o) => o.reconcileAttempts === 0)).toHaveLength(7); // el resto conserva su sitio en la cola
      } finally {
        await prisma.order.deleteMany({ where: { id: { in: mine } } });
      }
    });
  });
});
