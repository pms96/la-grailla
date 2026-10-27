import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as cron } from '@/app/api/cron/reconcile-payments/route';
import { completeOrder } from '@/lib/reconciliation/entradas';
import { completeShopOrder, reviveShopOrder } from '@/lib/reconciliation/tienda';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway, paid, state } from '../helpers/fake-gateway';

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

/* M2 (reembolsos hechos a mano), M4 (reembolsos simultáneos sin falsas alertas) y B1 (carrera del reembolso tardío de la tienda), con la pasarela
 * falsa ampliada: modela pagos REEMBOLSADOS, reembolsos en curso con la misma clave de idempotencia y pasarelas sin idempotencia. */

const HOURS = 60 * 60_000;
const to = (pattern: RegExp) => mail.sent.filter((m) => pattern.test(m.subject));

describe('reembolsos y pago tardío', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const eventIds: string[] = [];
  const productIds: string[] = [];
  let n = 0;
  const pid = () => `cs_rf_${Date.now()}_${n++}`;

  beforeAll(async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    event = await createTestEvent({ maxCapacity: 100 });
    tt = await createTicketType(event.id, { maxQuantity: 100 });
    eventIds.push(event.id);
  });
  afterAll(async () => {
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    for (const id of eventIds) {
      await prisma.ticketType.deleteMany({ where: { eventId: id } }).catch(() => {});
      await cleanupTestEvent(id);
    }
    await prisma.processedWebhookEvent.deleteMany({ where: { id: { startsWith: 'late-refund:' } } });
  });
  beforeEach(async () => {
    gateway.reset();
    gateway.active = true;
    mail.sent.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await prisma.ticket.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.order.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.ticketType.updateMany({ where: { eventId: { in: eventIds } }, data: { soldCount: 0 } });
  });
  afterEach(() => vi.restoreAllMocks());

  async function mkOrder(status: 'PENDING' | 'CANCELLED' | 'COMPLETED', opts: { eventId?: string; ticketTypeId?: string; ageMs?: number } = {}) {
    const eventId = opts.eventId ?? event.id;
    const ticketTypeId = opts.ticketTypeId ?? tt.id;
    const paymentId = pid();
    const o = await prisma.order.create({
      data: {
        eventId, buyerName: 'Rf', buyerLastName: 'Pago', buyerEmail: `rf-${Math.random()}@example.com`, totalAmount: 10, paymentProvider: 'fake', paymentId, status,
        createdAt: new Date(Date.now() - (opts.ageMs ?? 2 * HOURS)),
        tickets: { create: { eventId, ticketTypeId, qrCode: `QR-RF-${Math.random()}`, holderName: 'Rf', status: status === 'COMPLETED' ? 'VALID' : status === 'PENDING' ? 'PENDING' : 'CANCELLED' } },
      },
    });
    if (status !== 'CANCELLED') await prisma.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { increment: 1 } } });
    return o;
  }
  async function fullEvent() {
    const small = await createTestEvent({ maxCapacity: 1 });
    eventIds.push(small.id);
    const smallTt = await createTicketType(small.id, { maxQuantity: 1 });
    await mkOrder('COMPLETED', { eventId: small.id, ticketTypeId: smallTt.id });
    return { eventId: small.id, ticketTypeId: smallTt.id };
  }
  const reload = (id: string) => prisma.order.findUnique({ where: { id }, include: { tickets: true } });
  const sold = async () => (await prisma.ticketType.findUnique({ where: { id: tt.id } }))!.soldCount;

  describe('M2: un cobro reembolsado a mano en la pasarela NO se reanima ni se completa', () => {
    it('pedido CANCELLED con plazas libres: el pago consta REFUNDED → no se reanima, no se entregan entradas, alerta con el motivo', async () => {
      const o = await mkOrder('CANCELLED');
      gateway.refunded.add(o.paymentId!); // el operador lo reembolsó en el panel de Stripe
      expect(await completeOrder(o.id)).toBe('inactive');
      expect((await reload(o.id))?.status).toBe('CANCELLED');
      expect(await sold()).toBe(0);
      expect(to(/Tus entradas/)).toHaveLength(0);
      const alert = to(/reembolsado en la pasarela/);
      expect(alert).toHaveLength(1);
      expect(alert[0].html).toContain(o.id);
      expect(gateway.count('refund')).toBe(0); // y tampoco se reembolsa dos veces
    });

    it('la alerta no se repite más de una vez al día por pedido (webhook reintentado, GET de la confirmación…)', async () => {
      const o = await mkOrder('CANCELLED');
      gateway.refunded.add(o.paymentId!);
      await completeOrder(o.id);
      await completeOrder(o.id);
      await completeOrder(o.id);
      expect(to(/reembolsado en la pasarela/)).toHaveLength(1);
    });

    it('lo mismo en la tienda', async () => {
      const product = await prisma.product.create({ data: { name: 'Rf', slug: `rf-${Date.now()}-${n++}`, price: 10, variants: { create: { size: 'M', color: '', stock: 5 } } } });
      productIds.push(product.id);
      const o = await prisma.shopOrder.create({ data: { buyerName: 'R', buyerEmail: 'rf-shop@example.com', shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 10, paymentProvider: 'fake', paymentId: pid(), status: 'CANCELLED', items: { create: { productId: product.id, quantity: 1, unitPrice: 10, size: 'M', color: '' } } } });
      gateway.refunded.add(o.paymentId!);
      expect(await completeShopOrder(o.id)).toBe('inactive');
      expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('CANCELLED');
      expect((await prisma.productVariant.findFirst({ where: { productId: product.id } }))?.stock).toBe(5);
      expect(to(/Pedido confirmado/)).toHaveLength(0);
      expect(to(/reembolsado en la pasarela/)).toHaveLength(1);
    });

    it('un PENDING cuyo cobro consta reembolsado no se completa ni se libera: alerta (cron)', async () => {
      const o = await mkOrder('PENDING', { ageMs: 10 * 60_000 });
      gateway.refunded.add(o.paymentId!);
      const body = await (await cron(new Request('http://localhost/api/cron/reconcile-payments', { headers: { Authorization: 'Bearer test-cron-secret' } }))).json();
      expect((await reload(o.id))?.status).toBe('PENDING');
      expect(body.errors).toBe(1);
      expect(to(/cobro consta reembolsado/)).toHaveLength(1);
    });

    it('un pago NO reembolsado sigue el camino normal: se reanima y entrega', async () => {
      const o = await mkOrder('CANCELLED');
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      expect(await completeOrder(o.id)).toBe('revived');
      expect(to(/Tus entradas/)).toHaveLength(1);
    });

    it('si fue ESTE sistema quien reembolsó (marca late-refund) y se cortó antes de marcar el pedido, el reintento solo termina de marcarlo: sin segundo reembolso ni alerta de reembolso manual', async () => {
      const { eventId, ticketTypeId } = await fullEvent();
      const o = await mkOrder('CANCELLED', { eventId, ticketTypeId });
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      // Simula el corte: la marca está puesta y el reembolso hecho, pero el pedido sigue CANCELLED.
      await prisma.processedWebhookEvent.create({ data: { id: `late-refund:${o.id}` } });
      gateway.refunded.add(o.paymentId!);

      expect(await completeOrder(o.id)).toBe('refunded_late');
      expect((await reload(o.id))?.status).toBe('REFUNDED');
      expect(gateway.count('refund')).toBe(0);
      expect(to(/reembolsado en la pasarela/)).toHaveLength(0);
      expect(to(/Te hemos devuelto tu pago/)).toHaveLength(1);
    });
  });

  describe('M4: entregas simultáneas del mismo pago tardío sin plazas', () => {
    it('Stripe-like (misma clave, una petición en curso): una gana, la otra falla con «idempotency_key_in_use» y NO alerta; un solo email al comprador', async () => {
      const { eventId, ticketTypeId } = await fullEvent();
      const o = await mkOrder('CANCELLED', { eventId, ticketTypeId });
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      gateway.refundDelayMs = 150;

      const results = await Promise.all([completeOrder(o.id), completeOrder(o.id), completeOrder(o.id)]);

      expect(results.every((r) => r === 'refunded_late')).toBe(true);
      expect((await reload(o.id))?.status).toBe('REFUNDED');
      expect(to(/reembolso FALLIDO/)).toHaveLength(0); // ninguna alerta falsa
      expect(to(/Te hemos devuelto tu pago/)).toHaveLength(1);
      expect(to(/Pago tardío reembolsado/)).toHaveLength(1);
      // Y el dedupe del día NO se ha gastado: un fallo REAL posterior sí avisa.
    });

    it('SumUp-like (sin idempotencia: el segundo reembolso falla porque ya está reembolsado): tampoco alerta', async () => {
      const { eventId, ticketTypeId } = await fullEvent();
      const o = await mkOrder('CANCELLED', { eventId, ticketTypeId });
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      gateway.strictRefunds = true;
      gateway.refundDelayMs = 100;
      await Promise.all([completeOrder(o.id), completeOrder(o.id)]);
      expect((await reload(o.id))?.status).toBe('REFUNDED');
      expect(to(/reembolso FALLIDO/)).toHaveLength(0);
      expect(to(/Te hemos devuelto tu pago/)).toHaveLength(1);
    });

    it('un fallo REAL (la pasarela rechaza y el cobro no está reembolsado) sigue alertando exactamente una vez', async () => {
      const { eventId, ticketTypeId } = await fullEvent();
      const o = await mkOrder('CANCELLED', { eventId, ticketTypeId });
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      gateway.refundResult = { success: false, error: 'balance_insufficient' };
      const results = await Promise.all([completeOrder(o.id), completeOrder(o.id)]);
      expect(results.every((r) => r === 'late_unresolved')).toBe(true);
      expect((await reload(o.id))?.status).toBe('CANCELLED');
      expect(to(/reembolso FALLIDO/)).toHaveLength(1);
      expect(to(/reembolso FALLIDO/)[0].html).toContain('balance_insufficient');
      expect(to(/Te hemos devuelto/)).toHaveLength(0);
    });

    it('si el reembolso da error pero la pasarela, al volver a preguntar, lo da por reembolsado (el reembolso sí llegó), no alerta y termina el pedido', async () => {
      const { eventId, ticketTypeId } = await fullEvent();
      const o = await mkOrder('CANCELLED', { eventId, ticketTypeId });
      // 1.ª verificación: pagado. El reembolso responde error (timeout tras llegar a la pasarela). 2.ª verificación: ya reembolsado.
      gateway.script(o.paymentId!, paid(o.paymentId!, 10), state(o.paymentId!, 'REFUNDED'));
      gateway.refundResult = { success: false, error: 'timeout leyendo la respuesta' };
      expect(await completeOrder(o.id)).toBe('refunded_late');
      expect((await reload(o.id))?.status).toBe('REFUNDED');
      expect(to(/reembolso FALLIDO/)).toHaveLength(0);
      expect(to(/Te hemos devuelto tu pago/)).toHaveLength(1);
    });

    it('si el reembolso falla pero el pedido ya consta REFUNDED por otra entrega, no alerta', async () => {
      const { eventId, ticketTypeId } = await fullEvent();
      const o = await mkOrder('CANCELLED', { eventId, ticketTypeId });
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      gateway.refundResult = { success: false, error: 'lo que sea' };
      // Mientras esta entrega espera a la pasarela, otra termina el trabajo.
      gateway.refundDelayMs = 100;
      const first = completeOrder(o.id);
      await new Promise((r) => setTimeout(r, 30));
      await prisma.order.update({ where: { id: o.id }, data: { status: 'REFUNDED' } });
      expect(await first).toBe('refunded_late');
      expect(to(/reembolso FALLIDO/)).toHaveLength(0);
    });
  });

  describe('B1: carrera del reembolso tardío en la tienda (nunca PAID + reembolsado + entregado)', () => {
    async function shopCancelled(stock: number, productId?: string) {
      let pId = productId;
      if (!pId) {
        const p = await prisma.product.create({ data: { name: 'B1', slug: `b1-${Date.now()}-${n++}`, price: 10, variants: { create: { size: 'M', color: '', stock } } } });
        pId = p.id;
        productIds.push(pId);
      }
      const o = await prisma.shopOrder.create({ data: { buyerName: 'B', buyerEmail: `b1-${Math.random()}@example.com`, shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 10, paymentProvider: 'fake', paymentId: pid(), status: 'CANCELLED', items: { create: { productId: pId, quantity: 1, unitPrice: 10, size: 'M', color: '' } } } });
      return { o, productId: pId };
    }
    const stock = async (productId: string) => (await prisma.productVariant.findFirst({ where: { productId } }))!.stock;

    it('la marca «reembolsar» y la reactivación se serializan por pedido: dos entregas con stock apareciendo a mitad nunca acaban PAID y reembolsadas (20 iteraciones)', async () => {
      for (let i = 0; i < 20; i++) {
        const { o, productId } = await shopCancelled(0);
        gateway.script(o.paymentId!, paid(o.paymentId!, 10));
        gateway.refundDelayMs = 5;
        // Mientras dos entregas deciden, alguien libera una unidad de stock.
        await Promise.all([
          completeShopOrder(o.id),
          (async () => {
            await new Promise((r) => setTimeout(r, i % 4));
            await prisma.productVariant.updateMany({ where: { productId }, data: { stock: { increment: 1 } } });
          })(),
          completeShopOrder(o.id),
        ]);
        const final = (await prisma.shopOrder.findUnique({ where: { id: o.id } }))!.status;
        const refunded = gateway.refunded.has(o.paymentId!);
        // Invariante: o se entregó (PAID, sin reembolso) o se devolvió (REFUNDED), jamás las dos cosas.
        expect(final === 'PAID' && refunded, `iteración ${i}: ${final} refunded=${refunded}`).toBe(false);
        expect(['PAID', 'REFUNDED']).toContain(final);
        if (final === 'PAID') expect(await stock(productId)).toBe(0);
        gateway.refunded.clear();
      }
    });

    it('reviveShopOrder: sin stock deja la marca y no cambia el pedido; con la marca puesta no reanima aunque aparezca stock', async () => {
      const { o, productId } = await shopCancelled(0);
      expect(await reviveShopOrder(o.id)).toBe('no_stock');
      expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('CANCELLED');
      expect(await prisma.processedWebhookEvent.findUnique({ where: { id: `late-refund:${o.id}` } })).toBeTruthy();
      await prisma.productVariant.updateMany({ where: { productId }, data: { stock: 5 } });
      expect(await reviveShopOrder(o.id)).toBe('no_stock');
      expect(await stock(productId)).toBe(5);
    });

    it('dos reanimaciones simultáneas con stock para una sola: una PAID, la otra not_cancelled; stock descontado una vez', async () => {
      const { o, productId } = await shopCancelled(1);
      const results = await Promise.all([reviveShopOrder(o.id), reviveShopOrder(o.id)]);
      expect(results.sort()).toEqual(['not_cancelled', 'revived']);
      expect(await stock(productId)).toBe(0);
    });
  });
});
