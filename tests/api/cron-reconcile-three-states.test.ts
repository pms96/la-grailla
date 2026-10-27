import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as reconcilePayments } from '@/app/api/cron/reconcile-payments/route';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { gateway, paid, state, unknown } from '../helpers/fake-gateway';

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; html: string }[] }));
vi.mock('@/lib/mailer', async (orig) => ({
  ...(await orig<typeof import('@/lib/mailer')>()),
  sendMail: async (p: { to: string; subject: string; html: string }) => {
    mail.sent.push(p);
    return { success: true, transport: 'smtp' as const };
  },
}));
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return { ...actual, getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)) };
});

/* P0-06: la verificación de un pago es de TRES estados (pagado / no pagado confirmado / desconocido). Un fallo al consultar la pasarela
 * (clave caducada o mal puesta, caída, respuesta ilegible) NO es «no pagado»: a las 24 h el cron cancelaba ventas que podían estar cobradas. */

const cronRequest = () => new Request('http://localhost/api/cron/reconcile-payments', { headers: { Authorization: 'Bearer test-cron-secret' } });
const HOURS = 60 * 60_000;

describe('reconcile-payments: verificación de tres estados', () => {
  const originalCronSecret = process.env.CRON_SECRET;
  let originalApiKey: string | null;
  let originalMerchantCode: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;
  const productIds: string[] = [];

  beforeAll(async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    originalApiKey = await getAndSetConfig('sumup_api_key', 'clave-invalida');
    originalMerchantCode = await getAndSetConfig('sumup_merchant_code', 'MTEST');
    event = await createTestEvent();
    ticketType = await createTicketType(event.id, { maxQuantity: 50 });
  });

  afterAll(async () => {
    process.env.CRON_SECRET = originalCronSecret;
    await restoreConfig('sumup_api_key', originalApiKey);
    await restoreConfig('sumup_merchant_code', originalMerchantCode);
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await cleanupTestEvent(event.id);
  });

  beforeEach(async () => {
    gateway.reset();
    mail.sent.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: 0 } });
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function pendingOrder(provider: string, paymentId: string, ageMs: number) {
    const order = await prisma.order.create({
      data: {
        eventId: event.id, buyerName: 'Tres', buyerLastName: 'Estados', buyerEmail: `tres-${paymentId}@example.com`,
        totalAmount: 10, paymentProvider: provider, paymentId, status: 'PENDING',
        tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: `QR-3E-${paymentId}`, holderName: 'Tres Estados', status: 'PENDING' } },
      },
    });
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: { increment: 1 } } });
    return prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - ageMs) } });
  }
  const reload = (id: string) => prisma.order.findUnique({ where: { id }, include: { tickets: true } });
  const soldCount = async () => (await prisma.ticketType.findUnique({ where: { id: ticketType.id } }))!.soldCount;
  const run = async () => {
    const res = await reconcilePayments(cronRequest());
    return { status: res.status, body: await res.json() };
  };

  /* ── SumUp REAL (adaptador de verdad con fetch simulado): el camino que de verdad recorre un cliente con la clave mal puesta ── */
  describe('adaptador SumUp con la consulta fallando', () => {
    const failures: [string, () => Response | Promise<Response>][] = [
      ['clave inválida (401)', () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })],
      ['pasarela caída (503)', () => new Response('Service Unavailable', { status: 503 })],
      ['respuesta ilegible (200 que no es JSON)', () => new Response('<html>mantenimiento</html>', { status: 200 })],
      ['red caída (el fetch lanza)', () => { throw new Error('socket hang up'); }],
    ];

    it.each(failures)('a las 24 h, con %s: el pedido NO se cancela, cuenta como error, se registra y el cron responde 502', async (_name, respond) => {
      const order = await pendingOrder('sumup', `chk-fail-${Math.random()}`, 25 * HOURS);
      vi.stubGlobal('fetch', vi.fn(async () => respond()));

      const { status, body } = await run();

      const after = await reload(order.id);
      expect(after?.status).toBe('PENDING'); // el comportamiento anterior lo cancelaba
      expect(after?.tickets.every((t) => t.status === 'PENDING')).toBe(true);
      expect(await soldCount()).toBe(1); // el aforo no se devolvió
      expect(body.released).toBe(0);
      expect(body.errors).toBe(1);
      expect(body.unknown).toBe(1);
      expect(body.errorSamples[0]).toContain(order.id);
      expect(body.oldestPendingMinutes).toBeGreaterThanOrEqual(25 * 60);
      expect(status).toBe(502); // todo lo examinado falló: el disparador del panel debe avisar
      // Log estructurado con cliente, pedido, proveedor y motivo.
      const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[reconcile]') && l.includes(order.id));
      expect(logged).toBeTruthy();
      expect(JSON.parse(logged!.slice('[reconcile] '.length))).toMatchObject({ orderId: order.id, provider: 'sumup', kind: 'entradas' });
    });

    it('a los 40 min (plazo normal de liberación) tampoco se libera con la pasarela fallando', async () => {
      const order = await pendingOrder('sumup', `chk-fail-40-${Math.random()}`, 45 * 60_000);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
      const { status, body } = await run();
      expect((await reload(order.id))?.status).toBe('PENDING');
      expect(body.unknown).toBe(1);
      expect(status).toBe(502);
    });

    it('en la TIENDA también: 25 h con la clave inválida no cancela el pedido ni devuelve el stock', async () => {
      const product = await prisma.product.create({ data: { name: 'Tres', slug: `tres-${Date.now()}`, price: 10, variants: { create: { size: 'M', color: '', stock: 4 } } } });
      productIds.push(product.id);
      const shop = await prisma.shopOrder.create({
        data: { buyerName: 'T', buyerEmail: 'tres-shop@example.com', shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 10, paymentProvider: 'sumup', paymentId: `shop-fail-${Date.now()}`, status: 'PENDING', createdAt: new Date(Date.now() - 25 * HOURS), items: { create: { productId: product.id, quantity: 1, unitPrice: 10, size: 'M', color: '' } } },
      });
      await prisma.productVariant.updateMany({ where: { productId: product.id }, data: { stock: 3 } }); // reservado: 4 → 3
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })));

      const { status, body } = await run();

      expect((await prisma.shopOrder.findUnique({ where: { id: shop.id } }))?.status).toBe('PENDING');
      expect((await prisma.productVariant.findFirst({ where: { productId: product.id } }))?.stock).toBe(3);
      expect(body).toMatchObject({ released: 0, unknown: 1, errors: 1 });
      expect(body.errorSamples[0]).toContain('tienda');
      expect(status).toBe(502);
    });

    it('con una mezcla (un pedido verificable y otro que falla) la pasada es 200 pero el error queda contado', async () => {
      const ok = await pendingOrder('sumup', 'chk-mix-ok', 5 * 60_000);
      const ko = await pendingOrder('sumup', 'chk-mix-ko', 5 * 60_000);
      vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('chk-mix-ok') ? new Response(JSON.stringify({ status: 'PENDING' }), { status: 200 }) : new Response('{}', { status: 401 }))));
      const { status, body } = await run();
      expect(status).toBe(200);
      expect(body).toMatchObject({ stillPending: 1, unknown: 1, errors: 1 });
      expect((await reload(ok.id))?.status).toBe('PENDING');
      expect((await reload(ko.id))?.status).toBe('PENDING');
    });
  });

  /* ── Pasarela inyectada: los estados que un adaptador real devolvería ── */
  describe('estados de cobro', () => {
    beforeEach(() => {
      gateway.active = true;
    });

    it('Stripe caído (la consulta da UNKNOWN) a las 24 h: no se cancela', async () => {
      const o = await pendingOrder('stripe', 'cs_down', 25 * HOURS);
      gateway.script('cs_down', unknown('cs_down', 'connect ECONNREFUSED'));
      const { status, body } = await run();
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(body).toMatchObject({ released: 0, unknown: 1, errors: 1 });
      expect(gateway.count('cancel')).toBe(0); // ni siquiera se intenta cerrar la sesión
      expect(status).toBe(502);
    });

    it('un adaptador que LANZA en vez de devolver UNKNOWN tampoco libera (red de seguridad del cron)', async () => {
      const o = await pendingOrder('stripe', 'cs_throws', 25 * HOURS);
      gateway.script('cs_throws', new Error('boom'));
      const { body } = await run();
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(body.errors).toBe(1);
    });

    it('un adaptador que no informa de status y dice «no pagado» se trata como UNKNOWN, no como no pagado', async () => {
      const o = await pendingOrder('stripe', 'cs_nostatus', 25 * HOURS);
      gateway.script('cs_nostatus', { success: false, paymentId: 'cs_nostatus', provider: 'fake' });
      const { body } = await run();
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(body.unknown).toBe(1);
    });

    it('sesión completa pero SIN pagar (pago asíncrono en curso, PROCESSING): no se libera NUNCA, ni a las 24 h ni a las 72 h', async () => {
      const young = await pendingOrder('stripe', 'cs_proc_1', 25 * HOURS);
      const old = await pendingOrder('stripe', 'cs_proc_2', 72 * HOURS);
      gateway.script('cs_proc_1', state('cs_proc_1', 'PROCESSING'));
      gateway.script('cs_proc_2', state('cs_proc_2', 'PROCESSING'));
      const { status, body } = await run();
      expect((await reload(young.id))?.status).toBe('PENDING');
      expect((await reload(old.id))?.status).toBe('PENDING');
      expect(body).toMatchObject({ processing: 2, released: 0, errors: 0 });
      expect(gateway.count('cancel')).toBe(0);
      expect(status).toBe(200); // la pasarela respondió con claridad: no es un fallo de la pasada
    });

    it('EXPIRED definitivo: se libera enseguida (sin esperar al plazo) y devuelve el aforo', async () => {
      const o = await pendingOrder('stripe', 'cs_exp', 5 * 60_000);
      gateway.script('cs_exp', state('cs_exp', 'EXPIRED'));
      const { body } = await run();
      expect((await reload(o.id))?.status).toBe('CANCELLED');
      expect(await soldCount()).toBe(0);
      expect(body.released).toBe(1);
    });

    it('PAID: se completa', async () => {
      const o = await pendingOrder('stripe', 'cs_paid', 5 * 60_000);
      gateway.script('cs_paid', paid('cs_paid', 10));
      const { body } = await run();
      const after = await reload(o.id);
      expect(after?.status).toBe('COMPLETED');
      expect(after?.tickets.every((t) => t.status === 'VALID')).toBe(true);
      expect(body.completed).toBe(1);
    });

    it('PENDING abierto dentro de plazo: se espera (sin cerrar la sesión)', async () => {
      const o = await pendingOrder('stripe', 'cs_open', 10 * 60_000);
      gateway.script('cs_open', state('cs_open', 'PENDING'));
      const { body } = await run();
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(body.stillPending).toBe(1);
      expect(gateway.count('cancel')).toBe(0);
    });

    it('la respuesta del cron expone unknown, processing y oldestPendingMinutes aunque no haya errores', async () => {
      await pendingOrder('stripe', 'cs_old_ref', 3 * HOURS);
      gateway.script('cs_old_ref', state('cs_old_ref', 'PROCESSING'));
      const { body } = await run();
      expect(body.unknown).toBe(0);
      expect(body.oldestPendingMinutes).toBeGreaterThanOrEqual(180);
      expect(Array.isArray(body.errorSamples)).toBe(true);
    });
  });

  /* M1: un pedido con el pago sin poder resolverse (UNKNOWN o PROCESSING) ya no se libera nunca; pasadas 24 h alguien tiene que enterarse. */
  describe('pedidos atascados más de 24 h (revisión manual)', () => {
    beforeEach(() => {
      gateway.active = true;
    });
    const stuckMails = () => mail.sent.filter((m) => /sin resolver desde hace más de 24 h/.test(m.subject));

    it('UNKNOWN a las 25 h: aviso al operador con el motivo y el id, log estructurado y stuckOver24h en la respuesta', async () => {
      const o = await pendingOrder('stripe', 'cs_stuck_u', 25 * HOURS);
      gateway.script('cs_stuck_u', unknown('cs_stuck_u', 'No such checkout.session'));
      const { body } = await run();
      expect(body.stuckOver24h).toBe(1);
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(stuckMails()).toHaveLength(1);
      expect(stuckMails()[0].html).toContain(o.id);
      expect(stuckMails()[0].html).toContain('No such checkout.session');
      const line = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[reconcile]') && l.includes('stuck_unknown'));
      expect(JSON.parse(line!.slice('[reconcile] '.length))).toMatchObject({ orderId: o.id, reason: 'stuck_unknown', provider: 'stripe' });
    });

    it('no repite el aviso más de una vez al día por pedido (aunque el cron pase cada 5 min), pero sigue contando en stuckOver24h', async () => {
      const o = await pendingOrder('stripe', 'cs_stuck_d', 30 * HOURS);
      gateway.script('cs_stuck_d', unknown('cs_stuck_d'));
      await run();
      await run();
      const third = (await run()).body;
      expect(stuckMails()).toHaveLength(1);
      expect(third.stuckOver24h).toBe(1);
      expect((await reload(o.id))?.status).toBe('PENDING');
    });

    it('PROCESSING a las 26 h: también avisa (y no libera)', async () => {
      const o = await pendingOrder('stripe', 'cs_stuck_p', 26 * HOURS);
      gateway.script('cs_stuck_p', state('cs_stuck_p', 'PROCESSING'));
      const { body } = await run();
      expect(body.stuckOver24h).toBe(1);
      expect(stuckMails()).toHaveLength(1);
      expect(stuckMails()[0].html).toContain('en curso');
      expect((await reload(o.id))?.status).toBe('PENDING');
    });

    it('un proveedor que ni se puede construir (credencial ilegible) a las 25 h también cuenta y avisa', async () => {
      gateway.active = false; // pasarela real SumUp con la clave inválida de este fichero
      const o = await pendingOrder('sumup', `chk-stuck-${Math.random()}`, 25 * HOURS);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
      const { body } = await run();
      expect(body.stuckOver24h).toBe(1);
      expect(stuckMails()).toHaveLength(1);
      expect((await reload(o.id))?.status).toBe('PENDING');
    });

    it('menos de 24 h (un hipo): sin aviso y stuckOver24h = 0; un pedido atascado que se resuelve deja de contar', async () => {
      const young = await pendingOrder('stripe', 'cs_young_u', 5 * HOURS);
      gateway.script('cs_young_u', unknown('cs_young_u'));
      const { body } = await run();
      expect(body.stuckOver24h).toBe(0);
      expect(stuckMails()).toHaveLength(0);
      gateway.script('cs_young_u', paid('cs_young_u', 10));
      await run();
      expect((await reload(young.id))?.status).toBe('COMPLETED');
    });
  });
});
