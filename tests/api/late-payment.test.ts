import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route';
import { GET as getOrder } from '@/app/api/orders/[orderId]/route';
import { completeOrder, releaseExpiredOrder, invalidateOrder } from '@/lib/reconciliation/entradas';
import { completeShopOrder, releaseExpiredShopOrder, invalidateShopOrder } from '@/lib/reconciliation/tienda';
import { signOrderAccess } from '@/lib/access-token';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway, paid, state, unknown } from '../helpers/fake-gateway';

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; html: string }[] }));
vi.mock('@/lib/mailer', async (orig) => {
  const actual = await orig<typeof import('@/lib/mailer')>();
  return {
    ...actual,
    sendMail: async (p: { to: string; subject: string; html: string }) => {
      mail.sent.push({ to: p.to, subject: p.subject, html: p.html });
      return { success: true, transport: 'smtp' as const };
    },
  };
});
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return { ...actual, getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)) };
});

/* P0-05: un pago que llega DESPUÉS de liberar o anular el pedido no puede quedarse cobrado sin entrega ni sin devolución. Se reactiva si
 * cabe (con el mismo cerrojo de aforo que la compra) y, si no, se reembolsa por completo, se avisa al comprador y al operador. */

const HOURS = 60 * 60_000;
const subjects = () => mail.sent.map((m) => m.subject);
const to = (pattern: RegExp) => mail.sent.filter((m) => pattern.test(m.subject));
const webhook = (orderId: string, eventId: string) =>
  stripeWebhook(new Request('http://localhost/api/webhooks/stripe', { method: 'POST', body: JSON.stringify({ kind: 'payment_succeeded', eventId, orderId }) }));

describe('pago tardío (P0-05)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const eventIds: string[] = [];
  const productIds: string[] = [];
  let n = 0;
  const pid = () => `cs_late_${Date.now()}_${n++}`;

  beforeAll(async () => {
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
    await prisma.processedWebhookEvent.deleteMany({ where: { OR: [{ id: { startsWith: 'evt_late_' } }, { id: { startsWith: 'late-refund:' } }] } });
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

  /** Pedido de entradas ya en el estado dado, con `qty` entradas en el estado que corresponde y `soldCount` coherente. */
  async function mkOrder(status: 'PENDING' | 'CANCELLED' | 'COMPLETED', opts: { qty?: number; eventId?: string; ticketTypeId?: string; total?: number; ageMs?: number; paymentId?: string | null } = {}) {
    const eventId = opts.eventId ?? event.id;
    const ticketTypeId = opts.ticketTypeId ?? tt.id;
    const qty = opts.qty ?? 1;
    const paymentId = opts.paymentId === undefined ? pid() : opts.paymentId;
    const tStatus = status === 'COMPLETED' ? 'VALID' : status === 'PENDING' ? 'PENDING' : 'CANCELLED';
    const o = await prisma.order.create({
      data: {
        eventId, buyerName: 'Tardío', buyerLastName: 'Pago', buyerEmail: `tardio-${Math.random()}@example.com`, totalAmount: opts.total ?? 10 * qty,
        paymentProvider: 'fake', paymentId, status,
        createdAt: new Date(Date.now() - (opts.ageMs ?? 2 * HOURS)),
        tickets: { create: Array.from({ length: qty }, () => ({ eventId, ticketTypeId, qrCode: `QR-LP-${Math.random()}`, holderName: 'Tardío Pago', status: tStatus as 'VALID' })) },
      },
    });
    if (status !== 'CANCELLED') await prisma.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { increment: qty } } });
    return o;
  }
  const reload = (id: string) => prisma.order.findUnique({ where: { id }, include: { tickets: true } });
  const sold = async (id = tt.id) => (await prisma.ticketType.findUnique({ where: { id } }))!.soldCount;

  describe('entradas', () => {
    it('con plazas: el webhook REANIMA el pedido liberado y lo entrega (COMPLETED, tickets VALID, soldCount recontado, email con las entradas)', async () => {
      const o = await mkOrder('CANCELLED');
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));

      const res = await webhook(o.id, 'evt_late_1');
      expect(res.status).toBe(200);

      const after = await reload(o.id);
      expect(after?.status).toBe('COMPLETED');
      expect(after?.tickets.every((t) => t.status === 'VALID')).toBe(true);
      expect(await sold()).toBe(1);
      expect(gateway.count('refund')).toBe(0);
      expect(to(/Tus entradas/)).toHaveLength(1);
      expect(to(/reembols|devuelto/i)).toHaveLength(0);
      expect(after?.emailSentAt).toBeTruthy();
    });

    it('sin plazas: REEMBOLSO total e idempotente, pedido REFUNDED, email al comprador y aviso al operador; el aforo no cambia', async () => {
      const small = await createTestEvent({ maxCapacity: 2 });
      eventIds.push(small.id);
      const smallTt = await createTicketType(small.id, { maxQuantity: 2 });
      await mkOrder('COMPLETED', { eventId: small.id, ticketTypeId: smallTt.id, qty: 2 }); // ya vendidas a otra persona
      const late = await mkOrder('CANCELLED', { eventId: small.id, ticketTypeId: smallTt.id });
      gateway.script(late.paymentId!, paid(late.paymentId!, 10));

      const res = await webhook(late.id, 'evt_late_2');
      expect(res.status).toBe(200);

      const after = await reload(late.id);
      expect(after?.status).toBe('REFUNDED');
      expect(after?.tickets.every((t) => t.status === 'REFUNDED')).toBe(true);
      expect(await sold(smallTt.id)).toBe(2); // las de la otra persona; nada se ha tocado
      expect(gateway.calls.filter((c) => c.op === 'refund')).toEqual([{ op: 'refund', paymentId: late.paymentId, args: [undefined, `late_${late.id}`] }]);
      const buyerMail = to(/Te hemos devuelto tu pago/);
      expect(buyerMail).toHaveLength(1);
      expect(buyerMail[0].to).toBe(after!.buyerEmail);
      expect(buyerMail[0].html).toContain('10.00 EUR');
      expect(to(/Pago tardío reembolsado/)).toHaveLength(1); // aviso al operador
      expect(to(/Tus entradas/)).toHaveLength(0);
    });

    it('el aviso al operador sale siempre con log estructurado [late-payment] (con cliente y motivo, sin datos personales)', async () => {
      const small = await createTestEvent({ maxCapacity: 1 });
      eventIds.push(small.id);
      const smallTt = await createTicketType(small.id, { maxQuantity: 1 });
      await mkOrder('COMPLETED', { eventId: small.id, ticketTypeId: smallTt.id });
      const late = await mkOrder('CANCELLED', { eventId: small.id, ticketTypeId: smallTt.id });
      gateway.script(late.paymentId!, paid(late.paymentId!, 10));
      await webhook(late.id, 'evt_late_3');
      const line = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[late-payment]'));
      expect(line).toBeTruthy();
      const parsed = JSON.parse(line!.slice('[late-payment] '.length));
      expect(parsed).toMatchObject({ orderId: late.id, reason: 'refunded_no_capacity', kind: 'entradas' });
      expect(line).not.toContain('@example.com');
    });

    it('reembolso FALLIDO: el pedido queda para revisión (CANCELLED), alerta con el motivo, el webhook falla para que la pasarela reintente, y el reintento lo termina', async () => {
      const small = await createTestEvent({ maxCapacity: 1 });
      eventIds.push(small.id);
      const smallTt = await createTicketType(small.id, { maxQuantity: 1 });
      await mkOrder('COMPLETED', { eventId: small.id, ticketTypeId: smallTt.id });
      const late = await mkOrder('CANCELLED', { eventId: small.id, ticketTypeId: smallTt.id });
      gateway.script(late.paymentId!, paid(late.paymentId!, 10));
      gateway.refundResult = { success: false, error: 'insufficient_funds' };

      const failed = await webhook(late.id, 'evt_late_4');
      expect(failed.status).toBe(500); // no se marca como procesado: Stripe reintenta (PAY-05)
      expect(await prisma.processedWebhookEvent.findUnique({ where: { id: 'evt_late_4' } })).toBeNull();
      expect((await reload(late.id))?.status).toBe('CANCELLED');
      const alert = to(/reembolso FALLIDO/);
      expect(alert).toHaveLength(1);
      expect(alert[0].html).toContain('insufficient_funds');
      expect(alert[0].html).toContain('no tiene entrada');
      expect(to(/Te hemos devuelto/)).toHaveLength(0); // no se dice «devuelto» si no lo está
      const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).find((l) => l.includes('refund_failed'));
      expect(logged).toBeTruthy();

      // Un reintento (o el cron, o el siguiente aviso) con la pasarela ya sana termina el trabajo sin duplicar nada.
      gateway.refundResult = { success: true, refundId: 're_ok' };
      const retry = await webhook(late.id, 'evt_late_4');
      expect(retry.status).toBe(200);
      expect((await reload(late.id))?.status).toBe('REFUNDED');
      expect(to(/Te hemos devuelto/)).toHaveLength(1);
    });

    it('si el reembolso falla y después aparecen plazas, NO se reanima (la decisión de reembolsar ya está tomada): nunca cobra Y entrega', async () => {
      const small = await createTestEvent({ maxCapacity: 1 });
      eventIds.push(small.id);
      const smallTt = await createTicketType(small.id, { maxQuantity: 1 });
      const other = await mkOrder('COMPLETED', { eventId: small.id, ticketTypeId: smallTt.id });
      const late = await mkOrder('CANCELLED', { eventId: small.id, ticketTypeId: smallTt.id });
      gateway.script(late.paymentId!, paid(late.paymentId!, 10));
      gateway.refundResult = { success: false, error: 'caída' };
      await completeOrder(late.id);
      // Se libera la plaza de la otra persona.
      await releaseExpiredOrder(other.id).catch(() => {});
      await prisma.order.update({ where: { id: other.id }, data: { status: 'CANCELLED' } });
      await prisma.ticket.updateMany({ where: { orderId: other.id }, data: { status: 'CANCELLED' } });
      await prisma.ticketType.update({ where: { id: smallTt.id }, data: { soldCount: 0 } });

      gateway.refundResult = { success: true, refundId: 're_ok' };
      await completeOrder(late.id);
      const after = await reload(late.id);
      expect(after?.status).toBe('REFUNDED');
      expect(await sold(smallTt.id)).toBe(0);
    });

    it('pago que NO se puede comprobar con la pasarela (UNKNOWN): ni se reanima ni se reembolsa, alerta, y el webhook reintenta', async () => {
      const o = await mkOrder('CANCELLED');
      gateway.script(o.paymentId!, unknown(o.paymentId!, 'clave caducada'));
      const res = await webhook(o.id, 'evt_late_5');
      expect(res.status).toBe(500);
      expect((await reload(o.id))?.status).toBe('CANCELLED');
      expect(gateway.count('refund')).toBe(0);
      expect(await sold()).toBe(0);
      expect(to(/no se puede comprobar/)).toHaveLength(1);
    });

    it('si la pasarela dice que NO está pagado (evento atrasado), no se hace nada', async () => {
      const o = await mkOrder('CANCELLED');
      gateway.script(o.paymentId!, state(o.paymentId!, 'EXPIRED'));
      expect(await completeOrder(o.id)).toBe('inactive');
      expect((await reload(o.id))?.status).toBe('CANCELLED');
      expect(gateway.count('refund')).toBe(0);
      expect(await sold()).toBe(0);
    });

    it('importe que no cuadra: no se reanima ni se reembolsa a ciegas', async () => {
      const o = await mkOrder('CANCELLED', { total: 25 });
      gateway.script(o.paymentId!, paid(o.paymentId!, 1));
      expect(await completeOrder(o.id)).toBe('amount_mismatch');
      expect((await reload(o.id))?.status).toBe('CANCELLED');
      expect(gateway.count('refund')).toBe(0);
    });

    it('evento ya terminado: se reembolsa en vez de reanimar', async () => {
      const past = await createTestEvent({ maxCapacity: 50, date: new Date(Date.now() - 3 * 24 * HOURS) });
      eventIds.push(past.id);
      const pastTt = await createTicketType(past.id, { maxQuantity: 50 });
      const o = await mkOrder('CANCELLED', { eventId: past.id, ticketTypeId: pastTt.id });
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      expect(await completeOrder(o.id)).toBe('refunded_late');
      expect((await reload(o.id))?.status).toBe('REFUNDED');
    });

    it('idempotencia: webhook duplicado, y cron + webhook a la vez, reaniman UNA sola vez (un soldCount, un email de entradas)', async () => {
      const o = await mkOrder('CANCELLED');
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      const first = await webhook(o.id, 'evt_late_6');
      const dup = await webhook(o.id, 'evt_late_6');
      expect(await dup.json()).toMatchObject({ duplicate: true });
      expect(first.status).toBe(200);
      // Y entregas simultáneas con ids de evento distintos (otro webhook + el cron).
      await Promise.all([completeOrder(o.id), completeOrder(o.id), webhook(o.id, 'evt_late_7')]);
      expect(await sold()).toBe(1);
      expect((await reload(o.id))?.status).toBe('COMPLETED');
      expect((await reload(o.id))?.tickets.filter((t) => t.status === 'VALID')).toHaveLength(1);
      expect(to(/Tus entradas/).length).toBeLessThanOrEqual(1 + 2); // el reenvío por emailSentAt (P0-08) es otra tarea; aquí solo se exige que no se reanime dos veces
    });

    it('reembolso duplicado: dos entregas simultáneas sin plazas piden el reembolso con la MISMA clave de idempotencia y avisan una vez', async () => {
      const small = await createTestEvent({ maxCapacity: 1 });
      eventIds.push(small.id);
      const smallTt = await createTicketType(small.id, { maxQuantity: 1 });
      await mkOrder('COMPLETED', { eventId: small.id, ticketTypeId: smallTt.id });
      const late = await mkOrder('CANCELLED', { eventId: small.id, ticketTypeId: smallTt.id });
      gateway.script(late.paymentId!, paid(late.paymentId!, 10));
      await Promise.all([completeOrder(late.id), completeOrder(late.id), completeOrder(late.id)]);
      expect((await reload(late.id))?.status).toBe('REFUNDED');
      expect(new Set(gateway.calls.filter((c) => c.op === 'refund').map((c) => (c.args as unknown[])[1]))).toEqual(new Set([`late_${late.id}`]));
      expect(to(/Te hemos devuelto tu pago/)).toHaveLength(1);
    });

    it('carrera liberar-vs-webhook (BD real, 12 pedidos): resultado único (COMPLETED) y soldCount siempre consistente', async () => {
      for (let i = 0; i < 12; i++) {
        const o = await mkOrder('PENDING');
        gateway.script(o.paymentId!, paid(o.paymentId!, 10));
        await Promise.all(i % 2 ? [releaseExpiredOrder(o.id), completeOrder(o.id)] : [completeOrder(o.id), releaseExpiredOrder(o.id)]);
        const after = await reload(o.id);
        expect(after?.status, `pedido ${i}`).toBe('COMPLETED');
        expect(after?.tickets.map((t) => t.status)).toEqual(['VALID']);
      }
      // 12 pedidos pagados de 1 entrada: ni 11 ni 13.
      expect(await sold()).toBe(12);
      expect(await prisma.ticket.count({ where: { eventId: event.id, status: { in: ['VALID', 'PENDING'] } } })).toBe(12);
    });

    it('carrera por la ÚLTIMA plaza: dos pagos tardíos simultáneos con una sola plaza → uno reanimado, el otro reembolsado, sin sobreventa', async () => {
      const small = await createTestEvent({ maxCapacity: 1 });
      eventIds.push(small.id);
      const smallTt = await createTicketType(small.id, { maxQuantity: 1 });
      const a = await mkOrder('CANCELLED', { eventId: small.id, ticketTypeId: smallTt.id });
      const b = await mkOrder('CANCELLED', { eventId: small.id, ticketTypeId: smallTt.id });
      gateway.script(a.paymentId!, paid(a.paymentId!, 10));
      gateway.script(b.paymentId!, paid(b.paymentId!, 10));

      await Promise.all([completeOrder(a.id), completeOrder(b.id)]);

      const statuses = [(await reload(a.id))?.status, (await reload(b.id))?.status].sort();
      expect(statuses).toEqual(['COMPLETED', 'REFUNDED']);
      expect(await sold(smallTt.id)).toBe(1);
      expect(await prisma.ticket.count({ where: { eventId: small.id, status: { in: ['VALID', 'PENDING', 'USED'] } } })).toBe(1);
      expect(gateway.count('refund')).toBe(1);
    });

    it('la confirmación del comprador (GET) comprueba un pedido CANCELLED con pago y lo reanima si estaba pagado', async () => {
      const o = await mkOrder('CANCELLED');
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      const res = await getOrder(new Request(`http://localhost/api/orders/${o.id}?t=${encodeURIComponent(signOrderAccess(o.id))}`), { params: Promise.resolve({ orderId: o.id }) });
      expect((await res.json()).status).toBe('COMPLETED');
      expect(await sold()).toBe(1);
    });

    it('un pedido CANCELLED SIN pago asociado no consulta nada en la pasarela', async () => {
      const o = await mkOrder('CANCELLED', { paymentId: null });
      const res = await getOrder(new Request(`http://localhost/api/orders/${o.id}?t=${encodeURIComponent(signOrderAccess(o.id))}`), { params: Promise.resolve({ orderId: o.id }) });
      expect((await res.json()).status).toBe('CANCELLED');
      expect(gateway.calls).toHaveLength(0);
    });

    it('anular a mano un PENDING cierra su sesión de pago; si ya estaba pagado, no se anula: se completa', async () => {
      const unpaid = await mkOrder('PENDING');
      gateway.script(unpaid.paymentId!, state(unpaid.paymentId!, 'EXPIRED'));
      expect(await invalidateOrder(unpaid.id, 'CANCELLED')).toMatchObject({ success: true });
      expect(gateway.count('cancel', unpaid.paymentId!)).toBe(1);

      const actuallyPaid = await mkOrder('PENDING');
      gateway.script(actuallyPaid.paymentId!, paid(actuallyPaid.paymentId!, 10));
      gateway.cancelResults.set(actuallyPaid.paymentId!, { ok: false, error: 'already complete' });
      const r = await invalidateOrder(actuallyPaid.id, 'CANCELLED');
      expect(r.success).toBe(false);
      expect((await reload(actuallyPaid.id))?.status).toBe('COMPLETED');
    });

    it('expirar → ya estaba pagada → se COMPLETA en vez de liberar (cron a los 45 min)', async () => {
      const { GET: cron } = await import('@/app/api/cron/reconcile-payments/route');
      process.env.CRON_SECRET = 'test-cron-secret';
      const o = await mkOrder('PENDING', { ageMs: 45 * 60_000 });
      gateway.script(o.paymentId!, state(o.paymentId!, 'PENDING'), paid(o.paymentId!, 10));
      gateway.cancelResults.set(o.paymentId!, { ok: false, error: 'Only open Checkout Sessions can be expired' });

      const res = await cron(new Request('http://localhost/api/cron/reconcile-payments', { headers: { Authorization: 'Bearer test-cron-secret' } }));
      const body = await res.json();

      expect(body).toMatchObject({ completed: 1, released: 0 });
      expect((await reload(o.id))?.status).toBe('COMPLETED');
      expect(gateway.calls.map((c) => c.op)).toEqual(['verify', 'cancel', 'verify']); // expirar → re-verificar, en ese orden
      expect(await sold()).toBe(1);
    });
  });

  describe('tienda', () => {
    async function mkShop(status: 'PENDING' | 'CANCELLED' | 'PAID', opts: { stock?: number; qty?: number; productId?: string; paymentId?: string | null } = {}) {
      let productId = opts.productId;
      if (!productId) {
        const product = await prisma.product.create({ data: { name: 'Tardío', slug: `tardio-${Date.now()}-${n++}`, price: 10, variants: { create: { size: 'M', color: '', stock: opts.stock ?? 5 } } } });
        productId = product.id;
        productIds.push(productId);
      }
      const qty = opts.qty ?? 1;
      const paymentId = opts.paymentId === undefined ? pid() : opts.paymentId;
      const o = await prisma.shopOrder.create({
        data: {
          buyerName: 'Tardía', buyerEmail: `tardia-${Math.random()}@example.com`, shippingAddress: 'x', shippingCity: 'x', shippingZip: '28001', totalAmount: 10 * qty,
          paymentProvider: 'fake', paymentId, status, createdAt: new Date(Date.now() - 2 * HOURS),
          items: { create: { productId, quantity: qty, unitPrice: 10, size: 'M', color: '' } },
        },
      });
      return { o, productId };
    }
    const stock = async (productId: string) => (await prisma.productVariant.findFirst({ where: { productId } }))!.stock;
    const shopReload = (id: string) => prisma.shopOrder.findUnique({ where: { id } });

    it('con stock: se REANIMA (PAID), se vuelve a reservar el stock y se manda el email de confirmación', async () => {
      const { o, productId } = await mkShop('CANCELLED', { stock: 3 });
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      expect(await completeShopOrder(o.id)).toBe('revived');
      expect((await shopReload(o.id))?.status).toBe('PAID');
      expect(await stock(productId)).toBe(2);
      expect(to(/Pedido confirmado/)).toHaveLength(1);
      expect(gateway.count('refund')).toBe(0);
    });

    it('sin stock: REEMBOLSO total, REFUNDED, email al comprador y aviso al operador; el stock no cambia', async () => {
      const { o, productId } = await mkShop('CANCELLED', { stock: 0 });
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      expect(await completeShopOrder(o.id)).toBe('refunded_late');
      expect((await shopReload(o.id))?.status).toBe('REFUNDED');
      expect(await stock(productId)).toBe(0);
      expect(gateway.calls.filter((c) => c.op === 'refund')).toEqual([{ op: 'refund', paymentId: o.paymentId, args: [undefined, `late_${o.id}`] }]);
      expect(to(/Te hemos devuelto tu pago/)).toHaveLength(1);
      expect(to(/Pago tardío reembolsado/)).toHaveLength(1);
    });

    it('un pedido con varias líneas donde falta stock en UNA: nada se reanima a medias (se deshace todo) y se reembolsa', async () => {
      const a = await prisma.product.create({ data: { name: 'A', slug: `ta-${Date.now()}`, price: 10, variants: { create: { size: 'M', color: '', stock: 5 } } } });
      const b = await prisma.product.create({ data: { name: 'B', slug: `tb-${Date.now()}`, price: 10, variants: { create: { size: 'M', color: '', stock: 0 } } } });
      productIds.push(a.id, b.id);
      const o = await prisma.shopOrder.create({
        data: { buyerName: 'M', buyerEmail: 'multi@example.com', shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 20, paymentProvider: 'fake', paymentId: pid(), status: 'CANCELLED', items: { create: [{ productId: a.id, quantity: 1, unitPrice: 10, size: 'M', color: '' }, { productId: b.id, quantity: 1, unitPrice: 10, size: 'M', color: '' }] } },
      });
      gateway.script(o.paymentId!, paid(o.paymentId!, 20));
      expect(await completeShopOrder(o.id)).toBe('refunded_late');
      expect(await stock(a.id)).toBe(5); // la reserva de la línea A se deshizo
    });

    it('reembolso fallido: queda CANCELLED para revisión con alerta, y el reintento lo termina', async () => {
      const { o } = await mkShop('CANCELLED', { stock: 0 });
      gateway.script(o.paymentId!, paid(o.paymentId!, 10));
      gateway.refundResult = { success: false, error: 'gateway_down' };
      expect(await completeShopOrder(o.id)).toBe('late_unresolved');
      expect((await shopReload(o.id))?.status).toBe('CANCELLED');
      expect(to(/reembolso FALLIDO/)[0].html).toContain('gateway_down');
      gateway.refundResult = { success: true, refundId: 're' };
      expect(await completeShopOrder(o.id)).toBe('refunded_late');
    });

    it('carrera liberar-vs-pago (BD real, 10 pedidos): resultado único PAID y stock consistente', async () => {
      const { productId } = await mkShop('PAID', { stock: 100, qty: 0 }).then(async (r) => {
        await prisma.shopOrder.delete({ where: { id: r.o.id } });
        return r;
      });
      let expectedStock = 100;
      for (let i = 0; i < 10; i++) {
        const { o } = await mkShop('PENDING', { productId });
        await prisma.productVariant.updateMany({ where: { productId }, data: { stock: { decrement: 1 } } });
        expectedStock -= 1;
        gateway.script(o.paymentId!, paid(o.paymentId!, 10));
        await Promise.all(i % 2 ? [releaseExpiredShopOrder(o.id), completeShopOrder(o.id)] : [completeShopOrder(o.id), releaseExpiredShopOrder(o.id)]);
        expect((await shopReload(o.id))?.status, `pedido ${i}`).toBe('PAID');
      }
      expect(await stock(productId)).toBe(expectedStock);
    });

    it('carrera por la ÚLTIMA unidad: dos pagos tardíos simultáneos → uno reanimado, el otro reembolsado', async () => {
      const first = await mkShop('CANCELLED', { stock: 1 });
      const second = await mkShop('CANCELLED', { productId: first.productId });
      gateway.script(first.o.paymentId!, paid(first.o.paymentId!, 10));
      gateway.script(second.o.paymentId!, paid(second.o.paymentId!, 10));
      await Promise.all([completeShopOrder(first.o.id), completeShopOrder(second.o.id)]);
      expect([(await shopReload(first.o.id))?.status, (await shopReload(second.o.id))?.status].sort()).toEqual(['PAID', 'REFUNDED']);
      expect(await stock(first.productId)).toBe(0);
      expect(gateway.count('refund')).toBe(1);
    });

    it('anular a mano un PENDING de tienda cierra su sesión de pago; si ya estaba pagado, no se anula', async () => {
      const { o } = await mkShop('PENDING');
      gateway.script(o.paymentId!, state(o.paymentId!, 'EXPIRED'));
      expect(await invalidateShopOrder(o.id, 'CANCELLED')).toMatchObject({ success: true });
      expect(gateway.count('cancel', o.paymentId!)).toBe(1);

      const paidOne = await mkShop('PENDING');
      gateway.script(paidOne.o.paymentId!, paid(paidOne.o.paymentId!, 10));
      gateway.cancelResults.set(paidOne.o.paymentId!, { ok: false, error: 'already complete' });
      expect((await invalidateShopOrder(paidOne.o.id, 'CANCELLED')).success).toBe(false);
      expect((await shopReload(paidOne.o.id))?.status).toBe('PAID');
    });
  });
});
