import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as stripeWebhook, maxDuration as stripeMaxDuration } from '@/app/api/webhooks/stripe/route';
import { POST as genericWebhook, maxDuration as genericMaxDuration } from '@/app/api/webhooks/[provider]/route';
import * as cronRoute from '@/app/api/cron/reconcile-payments/route';
import * as getOrderRoute from '@/app/api/orders/[orderId]/route';
import * as getShopOrderRoute from '@/app/api/shop/orders/[orderId]/route';
import { POST as sendTickets } from '@/app/api/orders/[orderId]/send-tickets/route';
import { POST as shopSendEmail } from '@/app/api/shop/orders/[orderId]/send-email/route';
import { POST as adminResend } from '@/app/api/admin/orders/[id]/resend-email/route';
import { POST as adminShopResend } from '@/app/api/admin/shop-orders/[id]/resend-email/route';
import { GET as adminOrders } from '@/app/api/admin/orders/route';
import { GET as adminShopOrders } from '@/app/api/admin/shop-orders/route';
import { completeOrder } from '@/lib/reconciliation/entradas';
import { completeShopOrder } from '@/lib/reconciliation/tienda';
import { EMAIL_BACKOFF_MS, EMAIL_MAX_ATTEMPTS, claimEmailSend, getEmailState, recordEmailFailure } from '@/lib/email-delivery';
import { BUYER_RESEND_PER_HOUR, EMAIL_SWEEP_BATCH, classifyEmailFailure, runAfterResponse, sendOrderEmail, sweepUnsentOrderEmails } from '@/lib/order-email';
import { signOrderAccess, signShopOrderAccess } from '@/lib/access-token';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';

const ctl = vi.hoisted(() => ({
  calls: [] as { to: string; subject: string; html: string; attachments: number }[],
  mode: 'ok' as 'ok' | 'fail',
  failWith: 'smtp_failed: ETIMEDOUT: Connection timeout',
  /** `errorCode` que devuelve el mailer falso al fallar (smtp_failed = genérico; smtp_unavailable = sistémico; smtp_rejected = permanente). */
  errorCode: 'smtp_failed' as 'smtp_failed' | 'smtp_unavailable' | 'smtp_rejected' | 'smtp_not_configured',
  /** El SMTP «cuelga»: la llamada no vuelve hasta que se libera. */
  hang: false,
  released: [] as (() => void)[],
  delayMs: 0,
  active: 0,
  maxActive: 0,
  /** Simula estar dentro de una petición: `after()` encola en vez de lanzar. */
  inRequest: false,
  queue: [] as (() => unknown)[],
  role: 'ADMIN' as string | null,
}));

vi.mock('@/lib/mailer', async (orig) => {
  const actual = await orig<typeof import('@/lib/mailer')>();
  return {
    ...actual,
    sendMail: async (p: { to: string; subject: string; html: string; attachments?: unknown[] }) => {
      ctl.calls.push({ to: p.to, subject: p.subject, html: p.html, attachments: p.attachments?.length ?? 0 });
      ctl.active += 1;
      ctl.maxActive = Math.max(ctl.maxActive, ctl.active);
      try {
        if (ctl.hang) await new Promise<void>((r) => ctl.released.push(r));
        else if (ctl.delayMs > 0) await new Promise((r) => setTimeout(r, ctl.delayMs));
      } finally {
        ctl.active -= 1;
      }
      return ctl.mode === 'fail' ? { success: false, transport: 'none' as const, error: ctl.failWith, errorCode: ctl.errorCode } : { success: true, transport: 'smtp' as const };
    },
  };
});
vi.mock('next/server', async (orig) => {
  const actual = await orig<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      if (!ctl.inRequest) throw new Error('`after` was called outside a request scope.');
      ctl.queue.push(task);
    },
  };
});
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => (ctl.role ? { user: { id: 'u-admin', role: ctl.role } } : null)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return { ...actual, getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)) };
});

/* P0-08: entrega fiable del email del pedido. Un solo punto de envío con concesión atómica, rastro de cada intento, reintento por el barrido del
 * cron con backoff y tope, envío fuera de la ruta crítica del webhook y estado real en pantallas y admin. BD real; el SMTP es un transporte falso. */

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const params = (orderId: string) => ({ params: Promise.resolve({ orderId }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const tickets = () => ctl.calls.filter((c) => /Tus entradas/.test(c.subject));
const shopMails = () => ctl.calls.filter((c) => /Pedido confirmado/.test(c.subject));
const alerts = () => ctl.calls.filter((c) => /emails de pedidos que no se pueden enviar/.test(c.subject));
const flush = async () => {
  while (ctl.queue.length) await ctl.queue.shift()!();
};
const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const webhook = (route: (request: Request, ctx: { params: Promise<{ provider: string }> }) => Promise<Response>, orderId: string, eventId: string) =>
  route(post('http://localhost/api/webhooks/stripe', { kind: 'payment_succeeded', eventId, orderId }), { params: Promise.resolve({ provider: 'stripe' }) });
const cron = async () => {
  const res = await cronRoute.GET(new Request('http://localhost/api/cron/reconcile-payments', { headers: { Authorization: 'Bearer test-cron-secret' } }));
  return { status: res.status, body: await res.json() };
};

describe('entrega del email del pedido (P0-08)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const productIds: string[] = [];
  const extraEvents: string[] = [];
  const shopIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    event = await createTestEvent({ maxCapacity: 500 });
    tt = await createTicketType(event.id, { maxQuantity: 500 });
  });
  afterAll(async () => {
    await prisma.processedWebhookEvent.deleteMany({ where: { OR: [{ id: { startsWith: 'email:shop:' } }, { id: { startsWith: 'evt_oe_' } }] } });
    await prisma.shopOrder.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.appConfig.deleteMany({ where: { key: 'ops_reconcile_last' } });
    await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'email-resend' } }, { key: { startsWith: 'send-tickets:10.' } }, { key: { startsWith: 'shop-send-email:10.' } }] } });
    for (const id of extraEvents) await cleanupTestEvent(id);
    await cleanupTestEvent(event.id);
  });
  beforeEach(async () => {
    gateway.reset();
    gateway.active = true; // los webhooks y el cron piden la pasarela: la falsa
    ctl.calls.length = 0;
    ctl.mode = 'ok';
    ctl.failWith = 'smtp_failed: ETIMEDOUT: Connection timeout';
    ctl.errorCode = 'smtp_failed';
    ctl.hang = false;
    ctl.delayMs = 0;
    ctl.active = 0;
    ctl.maxActive = 0;
    ctl.inRequest = false;
    ctl.queue.length = 0;
    ctl.role = 'ADMIN';
    delete process.env.RECONCILE_TIME_BUDGET_MS;
    delete process.env.EMAIL_SWEEP_BUDGET_MS;
    delete process.env.EMAIL_SEND_CAP_MS;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    // Los pedidos de pruebas anteriores no deben entrar en los barridos de esta prueba.
    await prisma.ticket.deleteMany({ where: { eventId: { in: [event.id, ...extraEvents] } } });
    await prisma.order.deleteMany({ where: { eventId: { in: [event.id, ...extraEvents] } } });
    await prisma.shopOrder.deleteMany({ where: { id: { in: shopIds } } });
    shopIds.length = 0;
    await prisma.processedWebhookEvent.deleteMany({ where: { id: { startsWith: 'email:shop:' } } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'email-resend' } } });
    await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'send-tickets:10.' } }, { key: { startsWith: 'shop-send-email:10.' } }] } }); // límites por IP de las IPs de prueba
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'operator-alert:email-failed' } } });
    await prisma.appConfig.deleteMany({ where: { key: 'ops_reconcile_last' } });
  });
  afterEach(() => {
    ctl.hang = false;
    for (const release of ctl.released.splice(0)) release(); // suelta los envíos «colgados» de la prueba
    vi.restoreAllMocks();
  });

  async function mkOrder(over: { eventId?: string; status?: 'PENDING' | 'COMPLETED'; attempts?: number; touchedAgoMs?: number; channel?: string; sentAt?: Date; lastError?: string } = {}) {
    const status = over.status ?? 'COMPLETED';
    const o = await prisma.order.create({
      data: {
        eventId: over.eventId ?? event.id, buyerName: 'Comprador', buyerLastName: 'Prueba', buyerEmail: `comprador-${Date.now()}-${n++}@example.com`, totalAmount: 10,
        status, channel: over.channel ?? 'ONLINE', paymentProvider: status === 'PENDING' ? 'fake' : null, paymentId: status === 'PENDING' ? `cs_oe_${Date.now()}_${n}` : null,
        emailAttempts: over.attempts ?? 0, emailSentAt: over.sentAt ?? null, emailLastError: over.lastError ?? null,
        createdAt: new Date(Date.now() - 5 * MIN),
        tickets: { create: [{ eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-OE-${Math.random()}`, holderName: 'Comprador Prueba', status: status === 'PENDING' ? 'PENDING' : 'VALID' }] },
      },
    });
    if (over.touchedAgoMs !== undefined) await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = ${ago(over.touchedAgoMs)} WHERE "id" = ${o.id}`;
    return o;
  }
  const touch = (id: string, agoMs: number) => prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = ${ago(agoMs)} WHERE "id" = ${id}`;
  const reload = (id: string) => prisma.order.findUnique({ where: { id } });

  async function mkShop(over: { status?: 'PENDING' | 'PAID' | 'CANCELLED'; items?: { name: string; size: string | null; color: string | null }[] } = {}) {
    const items = over.items ?? [{ name: 'Camiseta Tipo', size: 'M', color: 'Negro' }];
    const created: { productId: string; size: string | null; color: string | null }[] = [];
    for (const it of items) {
      const product = await prisma.product.create({ data: { name: it.name, slug: `oe-${Date.now()}-${n++}`, price: 10, variants: { create: { size: it.size ?? '', color: it.color ?? '', stock: 5 } } } });
      productIds.push(product.id);
      created.push({ productId: product.id, size: it.size, color: it.color });
    }
    const status = over.status ?? 'PAID';
    const o = await prisma.shopOrder.create({
      data: {
        buyerName: 'Tienda Prueba', buyerEmail: `tienda-${Date.now()}-${n++}@example.com`, shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001', totalAmount: 10 * items.length,
        status, paymentProvider: status === 'PENDING' ? 'fake' : null, paymentId: status === 'PENDING' ? `cs_oes_${Date.now()}_${n}` : null,
        items: { create: created.map((c) => ({ productId: c.productId, quantity: 1, unitPrice: 10, size: c.size, color: c.color })) },
      },
    });
    shopIds.push(o.id);
    return o;
  }
  const shopMarkers = async (id: string) => (await prisma.processedWebhookEvent.findMany({ where: { id: { startsWith: `email:shop:${id}` } } })).map((r) => r.id).sort();
  const shopAge = (id: string, agoMs: number) => prisma.processedWebhookEvent.updateMany({ where: { id: { startsWith: `email:shop:${id}` } }, data: { processedAt: ago(agoMs) } });

  describe('un solo punto de envío con concesión atómica', () => {
    it('ENTRADAS: 10 disparadores simultáneos (webhook, GET, cron, cliente…) mandan UN solo email', async () => {
      const o = await mkOrder();
      ctl.delayMs = 30; // el envío tarda: los demás llegan con el primero en curso
      const results = await Promise.all(Array.from({ length: 10 }, () => sendOrderEmail('entradas', o.id, { mode: 'auto' })));
      expect(tickets()).toHaveLength(1);
      expect(tickets()[0].to).toBe(o.buyerEmail);
      expect(tickets()[0].attachments).toBeGreaterThan(0); // el PDF
      expect(results.filter((r) => r.status === 'sent')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'skipped')).toHaveLength(9);
      expect(await getEmailState('entradas', o.id)).toMatchObject({ status: 'sent', attempts: 1 });
      expect((await reload(o.id))?.emailSentAt).toBeTruthy();
    });

    it('ENTRADAS: completeOrder concurrente (webhook + cron + verificación) → un único email', async () => {
      const o = await mkOrder({ status: 'PENDING' });
      ctl.delayMs = 20;
      await Promise.all([completeOrder(o.id), completeOrder(o.id), completeOrder(o.id), completeOrder(o.id)]);
      expect(tickets()).toHaveLength(1);
      expect((await reload(o.id))?.status).toBe('COMPLETED');
    });

    it('TIENDA: completeShopOrder concurrente → un único email, con talla y color de cada línea y enlace a la página del pedido', async () => {
      const o = await mkShop({ status: 'PENDING', items: [{ name: 'Camiseta Tipo', size: 'M', color: 'Negro' }, { name: 'Gorra Tipo', size: null, color: 'Rojo' }] });
      ctl.delayMs = 20;
      await Promise.all([completeShopOrder(o.id), completeShopOrder(o.id), completeShopOrder(o.id)]);
      expect(shopMails()).toHaveLength(1);
      const html = shopMails()[0].html;
      expect(html).toContain('Camiseta Tipo');
      expect(html).toContain('M · Negro');
      expect(html).toContain('Gorra Tipo');
      expect(html).toContain('Rojo');
      expect(html).toContain(`/tienda/confirmacion/${o.id}?t=${encodeURIComponent(signShopOrderAccess(o.id))}`);
      expect(await shopMarkers(o.id)).toEqual([`email:shop:${o.id}`, `email:shop:${o.id}:due`, `email:shop:${o.id}:try:1`].sort());
    });

    it('TIENDA: el pedido pagado queda anotado («se le debe un email») EN LA MISMA transacción que la transición a PAGADO', async () => {
      const o = await mkShop({ status: 'PENDING' });
      ctl.inRequest = true; // el envío queda diferido: lo único que hay es el rastro de la transición
      await completeShopOrder(o.id);
      expect((await prisma.shopOrder.findUnique({ where: { id: o.id } }))?.status).toBe('PAID');
      expect(await shopMarkers(o.id)).toEqual([`email:shop:${o.id}:due`]);
      expect(shopMails()).toHaveLength(0);
    });
  });

  describe('fallo del SMTP: intento registrado, reintento con backoff, éxito tras N fallos', () => {
    it('ENTRADAS: un fallo deja el intento y un texto corto sin datos personales; el barrido NO reintenta antes del backoff y SÍ después', async () => {
      const o = await mkOrder();
      ctl.mode = 'fail';
      ctl.failWith = `smtp_failed: 550 5.1.1 <${o.buyerEmail}> Recipient address rejected`;
      const first = await sendOrderEmail('entradas', o.id, { mode: 'auto' });
      expect(first).toMatchObject({ status: 'failed', attempt: 1, exhausted: false });
      const row = await reload(o.id);
      expect(row?.emailAttempts).toBe(1);
      expect(row?.emailSentAt).toBeNull();
      expect(row?.emailLastError).toBeTruthy();
      expect(row?.emailLastError).not.toContain(o.buyerEmail);
      expect(row?.emailLastError).not.toContain('@');
      expect(row?.emailLastError!.length).toBeLessThanOrEqual(160);

      // El barrido, recién fallado: aún dentro del backoff (2 min) → nada.
      const early = await sweepUnsentOrderEmails({ deadline: Date.now() + 10_000, concurrency: 5 });
      expect(early.examined).toBe(0);
      expect(ctl.calls).toHaveLength(1);

      // Pasado el backoff → reintenta (y falla otra vez: 2 intentos).
      await touch(o.id, EMAIL_BACKOFF_MS[0] + 5_000);
      const late = await sweepUnsentOrderEmails({ deadline: Date.now() + 10_000, concurrency: 5 });
      expect(late).toMatchObject({ examined: 1, failed: 1, sent: 0 });
      expect((await reload(o.id))?.emailAttempts).toBe(2);

      // SMTP recuperado: tras el backoff siguiente (5 min) se envía y consta.
      ctl.mode = 'ok';
      await touch(o.id, EMAIL_BACKOFF_MS[1] + 5_000);
      const recovered = await sweepUnsentOrderEmails({ deadline: Date.now() + 10_000, concurrency: 5 });
      expect(recovered).toMatchObject({ examined: 1, sent: 1 });
      expect(await getEmailState('entradas', o.id)).toMatchObject({ status: 'sent', attempts: 3 });
      expect(await reload(o.id)).toMatchObject({ emailLastError: null });
    });

    it('TIENDA: lo mismo con marcadores: intento anotado, reintento tras el backoff, enviado al recuperarse el SMTP', async () => {
      const o = await mkShop({ status: 'PENDING' });
      ctl.mode = 'fail';
      await completeShopOrder(o.id);
      expect(await shopMarkers(o.id)).toEqual([`email:shop:${o.id}:due`, `email:shop:${o.id}:try:1`].sort());
      expect((await getEmailState('tienda', o.id))?.status).toBe('retrying');

      expect((await sweepUnsentOrderEmails({ deadline: Date.now() + 10_000, concurrency: 5 })).examined).toBe(0); // dentro del backoff
      await shopAge(o.id, EMAIL_BACKOFF_MS[0] + 5_000);
      ctl.mode = 'ok';
      const swept = await sweepUnsentOrderEmails({ deadline: Date.now() + 10_000, concurrency: 5 });
      expect(swept).toMatchObject({ examined: 1, sent: 1 });
      expect(await getEmailState('tienda', o.id)).toMatchObject({ status: 'sent', attempts: 2 });
      expect(shopMails()).toHaveLength(2); // el primero falló y se registró; el segundo llegó
    });

    it('un envío que LANZA una excepción (no solo un success:false) también queda como fallo, sin romper a quien llama', async () => {
      const o = await mkOrder();
      const failing = vi.spyOn(await import('@/lib/tickets'), 'deliverTicketsEmail').mockRejectedValueOnce(new Error('PDF roto para nadie@example.com'));
      const r = await sendOrderEmail('entradas', o.id, { mode: 'auto' });
      failing.mockRestore();
      expect(r).toMatchObject({ status: 'failed', attempt: 1 });
      expect((await reload(o.id))?.emailLastError).toBe('PDF roto para [email]');
    });
  });

  describe('intentos agotados: «fallido definitivo», UN aviso agregado al operador y contador', () => {
    it('al 6.º intento fallido: exhausted; el aviso sale UNA vez por pasada y día, agregado, sin datos personales; el detalle por pedido queda en el log', async () => {
      const a = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS - 1, touchedAgoMs: 200 * MIN, lastError: 'smtp_failed: ETIMEDOUT' });
      const b = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS - 1, touchedAgoMs: 201 * MIN, lastError: 'smtp_failed: ETIMEDOUT' });
      const c = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS - 1, touchedAgoMs: 202 * MIN, lastError: 'smtp_failed: ETIMEDOUT' });
      ctl.mode = 'fail'; // fallo genérico (no sistémico): consume intentos
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5 });
      expect(r).toMatchObject({ examined: 3, failed: 3, exhausted: 3, systemic: 0 });
      for (const o of [a, b, c]) expect((await getEmailState('entradas', o.id))?.status).toBe('exhausted');

      // UN solo aviso para los tres, con el recuento y sin PII.
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0].subject).toContain('3 agotados');
      for (const o of [a, b, c]) {
        expect(alerts()[0].html).not.toContain(o.buyerEmail);
        expect(alerts()[0].html).not.toContain(o.id);
      }
      expect(alerts()[0].html).not.toContain('Comprador');
      // El detalle por pedido, en el log.
      const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((x) => String(x[0])).filter((l) => l.startsWith('[order-email]') && l.includes('email_exhausted'));
      expect(logged).toHaveLength(3);
      expect(logged.join('\n')).toContain(`"orderId":"${a.id}"`);
      expect(logged.join('\n')).not.toContain(a.buyerEmail);

      // Otra pasada el MISMO día con otro agotado: no se repite el aviso (el dedupe lleva cliente y día).
      const d = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS - 1, touchedAgoMs: 203 * MIN, lastError: 'x' });
      await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5 });
      expect((await getEmailState('entradas', d.id))?.status).toBe('exhausted');
      expect(alerts()).toHaveLength(1);
    });

    it('un reenvío manual que falla sobre un pedido agotado NO avisa (el aviso es del barrido) y ya no lo barre el cron', async () => {
      const o = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS, touchedAgoMs: 1000 * MIN, lastError: 'smtp_failed: ETIMEDOUT' });
      ctl.mode = 'fail';
      expect((await sweepUnsentOrderEmails({ deadline: Date.now() + 10_000, concurrency: 5 })).examined).toBe(0);
      const r = await sendOrderEmail('entradas', o.id, { mode: 'manual', resend: true });
      expect(r).toMatchObject({ status: 'failed', attempt: EMAIL_MAX_ATTEMPTS + 1, exhausted: true });
      expect(alerts()).toHaveLength(0);
      expect((await reload(o.id))?.emailAttempts).toBe(EMAIL_MAX_ATTEMPTS + 1);
    });

    it('tras agotar, un reenvío manual que SÍ funciona deja el pedido como enviado', async () => {
      const o = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS, touchedAgoMs: 500 * MIN, lastError: 'smtp_failed: ETIMEDOUT' });
      const r = await sendOrderEmail('entradas', o.id, { mode: 'manual', resend: true });
      expect(r.status).toBe('sent');
      expect((await getEmailState('entradas', o.id))?.status).toBe('sent');
    });

    it('TIENDA: 6 intentos agotan (el 6.º en el barrido), un aviso agregado y el contador de ops lo cuenta', async () => {
      const o = await mkShop({ status: 'PENDING' });
      ctl.mode = 'fail';
      await completeShopOrder(o.id);
      for (let i = 2; i < EMAIL_MAX_ATTEMPTS; i++) {
        await shopAge(o.id, 500 * MIN);
        await sendOrderEmail('tienda', o.id, { mode: 'auto' });
      }
      expect(await getEmailState('tienda', o.id)).toMatchObject({ status: 'retrying', attempts: EMAIL_MAX_ATTEMPTS - 1 });
      await shopAge(o.id, 500 * MIN);
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5 });
      expect(r).toMatchObject({ failed: 1, exhausted: 1 });
      expect(await getEmailState('tienda', o.id)).toMatchObject({ status: 'exhausted', attempts: EMAIL_MAX_ATTEMPTS });
      expect(alerts()).toHaveLength(1);
      expect(await sendOrderEmail('tienda', o.id, { mode: 'auto' })).toEqual({ status: 'skipped', reason: 'exhausted' });
      const { collectOps } = await import('@/lib/ops-health');
      expect((await collectOps())?.emailsFailed).toBeGreaterThanOrEqual(1);
    });
  });

  describe('M2: fallos sistémicos y permanentes (errorCode del mailer)', () => {
    it('classifyEmailFailure: sin SMTP, BD o servidor no disponible = sistémico; rechazo del destinatario = permanente; lo demás = normal', () => {
      for (const c of ['smtp_not_configured', 'config_unavailable', 'smtp_unavailable']) expect(classifyEmailFailure(c), c).toBe('systemic');
      expect(classifyEmailFailure('smtp_rejected')).toBe('permanent');
      for (const c of ['smtp_failed', undefined, null, 'otra']) expect(classifyEmailFailure(c as string | undefined), String(c)).toBe('normal');
    });

    it('SISTÉMICO (SMTP caído o sin configurar): no agota el pedido tras muchas rondas, se reintenta con backoff de 180 min y al recuperarse se envía', async () => {
      const o = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS - 1, touchedAgoMs: 200 * MIN, lastError: 'smtp_unavailable: ETIMEDOUT' });
      ctl.mode = 'fail';
      ctl.errorCode = 'smtp_unavailable';
      for (let round = 0; round < 4; round++) {
        const r = await sendOrderEmail('entradas', o.id, { mode: 'auto' });
        expect(r, `ronda ${round}`).toMatchObject({ status: 'failed', exhausted: false, failureClass: 'systemic' });
        await touch(o.id, 200 * MIN);
      }
      expect(await getEmailState('entradas', o.id)).toMatchObject({ status: 'retrying', attempts: EMAIL_MAX_ATTEMPTS - 1 });
      ctl.mode = 'ok';
      expect((await sendOrderEmail('entradas', o.id, { mode: 'auto' })).status).toBe('sent');
    });

    it('SIN SMTP configurado (errorCode smtp_not_configured): sistémico; el barrido da UN aviso agregado con el motivo, sin PII', async () => {
      await mkOrder({ attempts: 2, touchedAgoMs: 60 * MIN });
      await mkOrder({ attempts: 2, touchedAgoMs: 61 * MIN });
      ctl.mode = 'fail';
      ctl.errorCode = 'smtp_not_configured';
      ctl.failWith = 'No hay SMTP configurado';
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5 });
      expect(r).toMatchObject({ failed: 2, systemic: 2, exhausted: 0 });
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0].subject).toContain('0 agotados, 2 con fallo del servidor de correo');
      expect(alerts()[0].html).toContain('2 × el cliente no tiene el SMTP configurado');
      expect(alerts()[0].html).not.toMatch(/@|Comprador/);
    });

    it('PERMANENTE (el destinatario rechaza: errata): el pedido queda agotado ENSEGUIDA, con el primer intento, y no se reintenta', async () => {
      const o = await mkOrder();
      ctl.mode = 'fail';
      ctl.errorCode = 'smtp_rejected';
      ctl.failWith = 'smtp_rejected: el servidor ha rechazado al destinatario';
      const r = await sendOrderEmail('entradas', o.id, { mode: 'auto' });
      expect(r).toMatchObject({ status: 'failed', attempt: 1, exhausted: true, failureClass: 'permanent' });
      expect((await getEmailState('entradas', o.id))?.status).toBe('exhausted');
      await touch(o.id, 1000 * MIN);
      expect((await sweepUnsentOrderEmails({ deadline: Date.now() + 10_000, concurrency: 5 })).examined).toBe(0);
    });

    it('PERMANENTE en la tienda: agotado al instante (los 6 marcadores de intento) y el barrido lo da por agotado', async () => {
      const o = await mkShop({ status: 'PENDING' });
      ctl.mode = 'fail';
      ctl.errorCode = 'smtp_rejected';
      await completeShopOrder(o.id);
      expect(await getEmailState('tienda', o.id)).toMatchObject({ status: 'exhausted', attempts: EMAIL_MAX_ATTEMPTS });
    });

    it('un fallo SIN errorCode (una excepción propia, como el PDF) es normal: consume intentos', async () => {
      const o = await mkOrder();
      const failing = vi.spyOn(await import('@/lib/tickets'), 'deliverTicketsEmail').mockRejectedValueOnce(new Error('PDF roto'));
      const r = await sendOrderEmail('entradas', o.id, { mode: 'auto' });
      failing.mockRestore();
      expect(r).toMatchObject({ status: 'failed', failureClass: 'normal', exhausted: false });
      expect((await reload(o.id))?.emailAttempts).toBe(1);
    });
  });

  describe('A2: el barrido no puede retener al cron aunque el SMTP cuelgue', () => {
    it('SMTP que CUELGA: el cron responde dentro de su presupuesto, la concesión queda liberada, el fallo registrado y el resumen guardado', async () => {
      for (let i = 0; i < 4; i++) await mkOrder({ touchedAgoMs: (30 + i) * MIN });
      ctl.hang = true;
      ctl.inRequest = true; // como en producción: el cron corre dentro de una petición, así que el aviso al operador sale tras la respuesta
      process.env.EMAIL_SWEEP_BUDGET_MS = '300';
      process.env.EMAIL_SEND_CAP_MS = '500';
      const t0 = Date.now();
      const { body } = await cron();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(3_000); // sin el tope, esperaría a que el SMTP respondiese (nunca)
      expect(body.emails).toMatchObject({ examined: 4, sent: 0, failed: 4, systemic: 4, exhausted: 0 });
      // Concesión liberada y fallo anotado: ninguno queda «enviándose»; todos listos para reintentar con backoff.
      for (const row of await prisma.order.findMany({ where: { eventId: event.id } })) {
        expect(row.emailLastError, row.id).not.toMatch(/^sending:/);
        expect(row.emailLastError).toMatch(/^smtp_unavailable: /);
        expect(row.emailAttempts).toBe(1);
        expect((await getEmailState('entradas', row.id))?.status).toBe('retrying');
      }
      expect(ctl.queue).toHaveLength(1); // el aviso agregado (fallo del servidor de correo) queda aparte, no en el lote
      // El resumen para el panel se escribió igualmente.
      const summary = JSON.parse((await prisma.appConfig.findUnique({ where: { key: 'ops_reconcile_last' } }))!.value);
      expect(Date.now() - Date.parse(summary.lastRunAt)).toBeLessThan(10_000);
    });

    it('el resumen de la pasada se escribe ANTES del barrido: aunque el barrido se cuelgue o falle, `ops_reconcile_last` consta', async () => {
      const o = await mkOrder({ touchedAgoMs: 30 * MIN });
      ctl.hang = true;
      process.env.EMAIL_SWEEP_BUDGET_MS = '200';
      process.env.EMAIL_SEND_CAP_MS = '10000'; // el tope por envío NO acorta: lo corta el tope de la pasada (presupuesto + margen)
      const pending = cron();
      await new Promise((r) => setTimeout(r, 120)); // el barrido ya está esperando al SMTP
      const row = await prisma.appConfig.findUnique({ where: { key: 'ops_reconcile_last' } });
      expect(row).not.toBeNull(); // escrito antes de que el barrido termine
      expect(JSON.parse(row!.value).lastRunAt).toEqual(expect.any(String));
      const { body } = await pending;
      expect(body).toHaveProperty('checked');
      expect(body.emails === null || body.emails.failed >= 0).toBe(true);
      void o;
    }, 20_000);

    it('tope duro por envío: con capMs el envío colgado se da por fallido (sistémico) y se libera la concesión; sin colgarse, no estorba', async () => {
      const o = await mkOrder();
      ctl.hang = true;
      const t0 = Date.now();
      const r = await sendOrderEmail('entradas', o.id, { mode: 'auto', capMs: 150 });
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(r).toMatchObject({ status: 'failed', failureClass: 'systemic', errorCode: 'smtp_unavailable', exhausted: false });
      expect((await reload(o.id))?.emailLastError).toMatch(/^smtp_unavailable: .*no terminó en/);
      expect((await getEmailState('entradas', o.id))?.status).toBe('retrying');
      // Si el SMTP acaba aceptando el correo más tarde (la función sigue viva), consta enviado: mejor eso que reenviarlo y duplicarlo.
      ctl.hang = false;
      for (const release of ctl.released.splice(0)) release();
      await new Promise((r) => setTimeout(r, 300));
      expect((await getEmailState('entradas', o.id))?.status).toBe('sent');
    });

    it('sin colgarse, el tope duro no estorba: un envío normal con capMs se confirma', async () => {
      const o = await mkOrder();
      expect((await sendOrderEmail('entradas', o.id, { mode: 'auto', capMs: 5_000 })).status).toBe('sent');
    });

    it('comprueba el plazo ENTRE emails, no solo entre grupos: con concurrencia 1 y plazo corto, no empieza los que ya no caben', async () => {
      for (let i = 0; i < 5; i++) await mkOrder({ touchedAgoMs: (30 + i) * MIN });
      ctl.delayMs = 80;
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 200, concurrency: 1, limit: 5 });
      expect(r.examined).toBeGreaterThanOrEqual(2);
      expect(r.examined).toBeLessThan(5);
      expect(r.deferred).toBe(5 - r.examined);
      expect(tickets()).toHaveLength(r.examined);
    });

    it('el aviso de agotados NO bloquea el lote: con una petición en curso sale tras la respuesta (la cola), y el barrido vuelve aunque el SMTP cuelgue', async () => {
      await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS - 1, touchedAgoMs: 200 * MIN });
      ctl.mode = 'fail';
      ctl.inRequest = true;
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 10_000, concurrency: 5 });
      expect(r.exhausted).toBe(1);
      expect(alerts()).toHaveLength(0); // aún no se ha enviado: está en la cola de tareas posteriores
      expect(ctl.queue).toHaveLength(1);
      ctl.hang = true; // el SMTP del aviso cuelga: con el tope propio de 4 s la tarea termina sola, y el lote ya había vuelto
      const t0 = Date.now();
      await Promise.race([flush(), new Promise((res) => setTimeout(res, 5_000))]);
      expect(Date.now() - t0).toBeLessThan(5_000);
    }, 15_000);

    it('el presupuesto propio del barrido nunca pasa del plazo de la pasada: con el plazo ya vencido no envía nada', async () => {
      await mkOrder({ touchedAgoMs: 30 * MIN });
      process.env.RECONCILE_TIME_BUDGET_MS = '1';
      await new Promise((r) => setTimeout(r, 5));
      const { body } = await cron();
      expect(body.emails).toMatchObject({ examined: 0, sent: 0 });
      expect(tickets()).toHaveLength(0);
    });
  });

  describe('M1: el barrido no reenvía «Tus entradas» de eventos cancelados ni pasados', () => {
    const HOUR = 60 * MIN;
    const evAt = async (status: 'DRAFT' | 'PUBLISHED' | 'FINISHED' | 'CANCELLED', offsetMs: number) => {
      const e = await createTestEvent({ status, date: new Date(Date.now() + offsetMs) });
      extraEvents.push(e.id);
      return e;
    };

    it('de punta a punta: cancelado, borrador y pasado hace 3 días NO se envían; pasado hace 2 h y futuro SÍ', async () => {
      const cancelled = await mkOrder({ eventId: (await evAt('CANCELLED', 5 * 24 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const draft = await mkOrder({ eventId: (await evAt('DRAFT', 5 * 24 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const past3d = await mkOrder({ eventId: (await evAt('FINISHED', -3 * 24 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const past2h = await mkOrder({ eventId: (await evAt('PUBLISHED', -2 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const future = await mkOrder({ eventId: (await evAt('PUBLISHED', 3 * 24 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5, limit: 10 });
      expect(r.sent).toBe(2);
      const sentTo = new Set(tickets().map((c) => c.to));
      for (const o of [past2h, future]) expect(sentTo.has((await reload(o.id))!.buyerEmail), o.id).toBe(true);
      for (const o of [cancelled, draft, past3d]) {
        expect(sentTo.has((await reload(o.id))!.buyerEmail), o.id).toBe(false);
        expect((await reload(o.id))?.emailAttempts).toBe(0); // ni siquiera se intentó
      }
    });
  });

  describe('M4: el tope del lote se reparte entre entradas y tienda', () => {
    it('con 18 candidatos de entradas y 1 de tienda, la tienda SÍ se atiende en la pasada', async () => {
      for (let i = 0; i < 18; i++) await mkOrder({ touchedAgoMs: (60 + i) * MIN });
      const shop = await mkShop({ status: 'PENDING' });
      ctl.inRequest = true;
      await completeShopOrder(shop.id);
      ctl.inRequest = false;
      ctl.queue.length = 0;
      await shopAge(shop.id, 30 * MIN);
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5 });
      expect(r.examined).toBe(5); // el tope por pasada
      expect(shopMails()).toHaveLength(1);
      expect(tickets()).toHaveLength(4);
      expect(await getEmailState('tienda', shop.id)).toMatchObject({ status: 'sent' });
    });

    it('si un tipo no tiene candidatos, el otro usa todo el tope', async () => {
      for (let i = 0; i < 9; i++) await mkOrder({ touchedAgoMs: (60 + i) * MIN });
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5, limit: 6 });
      expect(r.examined).toBe(6);
      expect(tickets()).toHaveLength(6);
    });
  });

  describe('M6: error honesto si ni siquiera se puede reclamar el envío', () => {
    it('sendOrderEmail devuelve `error` (no «en curso») y el botón del comprador recibe un 503 reintentable, no «te lo estamos enviando»', async () => {
      const o = await mkOrder();
      const spy = vi.spyOn(await import('@/lib/email-delivery'), 'claimEmailSend').mockRejectedValue(new Error('conexión con la BD perdida'));
      ctl.role = null;
      const r = await sendOrderEmail('entradas', o.id, { mode: 'manual', resend: true });
      expect(r).toEqual({ status: 'error', error: 'claim_failed' });
      const res = await sendTickets(post(`http://localhost/api/orders/${o.id}/send-tickets`, { softResend: true, t: signOrderAccess(o.id) }, { 'x-vercel-forwarded-for': '10.9.0.1' }), params(o.id));
      spy.mockRestore();
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body).toMatchObject({ success: false, status: 'error' });
      expect(body.status).not.toBe('sending');
      expect(tickets()).toHaveLength(0);
      ctl.role = 'ADMIN';
      const admin = await adminResend(post(`http://localhost/api/admin/orders/${o.id}/resend-email`), idParams(o.id));
      expect(admin.status).toBe(200); // con la BD recuperada funciona
    });

    it('un pedido pagado sin intentos desde hace rato se le muestra al comprador como «reintentando», no «enviando»', async () => {
      const fresh = await mkOrder();
      const stale = await mkOrder({ touchedAgoMs: 10 * MIN });
      ctl.role = null;
      const get = async (id: string) => (await (await getOrderRoute.GET(new Request(`http://localhost/api/orders/${id}?t=${encodeURIComponent(signOrderAccess(id))}`), params(id))).json()).emailDelivery;
      expect(await get(fresh.id)).toBe('sending');
      expect(await get(stale.id)).toBe('retrying');
    });
  });

  describe('B4: la reactivación de un pago tardío de tienda deja el rastro en la MISMA transacción', () => {
    it('reviveShopOrder anota `:due` al reactivar y no deja nada si no hay stock', async () => {
      const { reviveShopOrder } = await import('@/lib/reconciliation/tienda');
      const ok = await mkShop({ status: 'CANCELLED' });
      expect(await reviveShopOrder(ok.id)).toBe('revived');
      expect(await shopMarkers(ok.id)).toEqual([`email:shop:${ok.id}:due`]);
      const noStock = await mkShop({ status: 'CANCELLED' });
      const line = await prisma.shopOrderItem.findFirstOrThrow({ where: { shopOrderId: noStock.id } });
      await prisma.productVariant.updateMany({ where: { productId: line.productId }, data: { stock: 0 } });
      expect(await reviveShopOrder(noStock.id)).toBe('no_stock');
      expect(await shopMarkers(noStock.id)).toEqual([]);
    });
  });

  describe('el webhook responde sin esperar al email (after) y la función no pierde el envío', () => {
    it('webhook de Stripe: 200 inmediato con el pedido COMPLETED y SIN email enviado; el email sale cuando corre la tarea posterior', async () => {
      const o = await mkOrder({ status: 'PENDING' });
      ctl.inRequest = true;
      ctl.delayMs = 25;
      const res = await webhook(stripeWebhook as never, o.id, `evt_oe_${o.id}`);
      expect(res.status).toBe(200);
      expect((await reload(o.id))?.status).toBe('COMPLETED');
      expect(tickets()).toHaveLength(0); // no se ha esperado al PDF ni al SMTP
      expect(ctl.queue).toHaveLength(1);
      expect(await getEmailState('entradas', o.id)).toMatchObject({ status: 'pending', attempts: 0 });

      await flush();
      expect(tickets()).toHaveLength(1);
      expect(await getEmailState('entradas', o.id)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('webhook genérico (tienda): igual; y si la función se corta antes de enviar, el barrido recupera el pedido (la tarea posterior se pierde)', async () => {
      const o = await mkShop({ status: 'PENDING' });
      ctl.inRequest = true;
      const res = await webhook(genericWebhook as never, o.id, `evt_oe_${o.id}`);
      expect(res.status).toBe(200);
      expect(shopMails()).toHaveLength(0);
      ctl.queue.length = 0; // la función murió: la tarea posterior nunca corre
      expect(await getEmailState('tienda', o.id)).toMatchObject({ status: 'pending', attempts: 0 });

      ctl.inRequest = false;
      await shopAge(o.id, 5 * MIN);
      const swept = await sweepUnsentOrderEmails({ deadline: Date.now() + 10_000, concurrency: 5 });
      expect(swept.sent).toBe(1);
      expect(shopMails()).toHaveLength(1);
    });

    it('un fallo del email dentro de la tarea posterior no tumba nada y queda registrado', async () => {
      const o = await mkOrder({ status: 'PENDING' });
      ctl.inRequest = true;
      ctl.mode = 'fail';
      expect((await webhook(stripeWebhook as never, o.id, `evt_oe_${o.id}`)).status).toBe(200);
      await flush();
      expect(await getEmailState('entradas', o.id)).toMatchObject({ status: 'retrying', attempts: 1 });
    });

    it('runAfterResponse: sin petición ejecuta en el acto; con petición difiere; y nunca lanza', async () => {
      const seen: string[] = [];
      expect(await runAfterResponse(async () => void seen.push('a'))).toBe('inline');
      expect(seen).toEqual(['a']);
      ctl.inRequest = true;
      expect(await runAfterResponse(async () => void seen.push('b'))).toBe('deferred');
      expect(seen).toEqual(['a']);
      await flush();
      expect(seen).toEqual(['a', 'b']);
      ctl.queue.length = 0;
      ctl.inRequest = false;
      await expect(runAfterResponse(async () => { throw new Error('x'); })).resolves.toBe('inline');
    });

    it('las rutas de webhook de pago y las que confirman pagos declaran maxDuration = 60', () => {
      expect(stripeMaxDuration).toBe(60);
      expect(genericMaxDuration).toBe(60);
      expect(getOrderRoute.maxDuration).toBe(60);
      expect(getShopOrderRoute.maxDuration).toBe(60);
    });
  });

  describe('barrido de reintentos', () => {
    it('respeta su tope por pasada: con más candidatos que el tope atiende solo ese tope y deja el resto para la siguiente', async () => {
      const ids = [];
      for (let i = 0; i < 6; i++) ids.push((await mkOrder({ touchedAgoMs: (30 + i) * MIN })).id);
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5, limit: 4 });
      expect(r.examined).toBe(4);
      expect(r.sent).toBe(4);
      expect(r.deferred).toBeGreaterThanOrEqual(1); // hay más candidatos de los que caben
      expect(tickets()).toHaveLength(4);
      // Los más antiguos primero (el último creado es el más viejo: hace 35 min).
      const sentIds = (await prisma.order.findMany({ where: { id: { in: ids }, emailSentAt: { not: null } }, select: { id: true } })).map((x) => x.id);
      expect(sentIds.sort()).toEqual(ids.slice(2).sort());
      expect(EMAIL_SWEEP_BATCH).toBeGreaterThan(0);
    });

    it('respeta el presupuesto de tiempo: con el plazo vencido no envía nada y lo cuenta como diferido; con tiempo, lo envía', async () => {
      await mkOrder({ touchedAgoMs: 30 * MIN });
      await mkOrder({ touchedAgoMs: 31 * MIN });
      const noTime = await sweepUnsentOrderEmails({ deadline: Date.now() - 1, concurrency: 5 });
      expect(noTime).toMatchObject({ examined: 0, sent: 0 });
      expect(noTime.deferred).toBe(2);
      expect(tickets()).toHaveLength(0);
      expect((await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5 })).sent).toBe(2);
    });

    it('respeta la concurrencia acotada: con 8 candidatos y concurrencia 3 nunca hay más de 3 envíos a la vez', async () => {
      for (let i = 0; i < 8; i++) await mkOrder({ touchedAgoMs: (30 + i) * MIN });
      ctl.delayMs = 25;
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 3, limit: 8 });
      expect(r.sent).toBe(8);
      expect(ctl.maxActive).toBeLessThanOrEqual(3);
      expect(ctl.maxActive).toBeGreaterThan(1);
    });

    it('NO duplica: dos barridos solapados mandan cada email una sola vez', async () => {
      for (let i = 0; i < 5; i++) await mkOrder({ touchedAgoMs: (30 + i) * MIN });
      ctl.delayMs = 20;
      const [a, b] = await Promise.all([
        sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5 }),
        sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5 }),
      ]);
      expect(tickets()).toHaveLength(5);
      expect(a.sent + b.sent).toBe(5);
    });

    it('barre entradas y tienda; no toca la taquilla ni las invitaciones, ni lo enviado, ni un pedido sin pagar', async () => {
      const online = await mkOrder({ touchedAgoMs: 30 * MIN });
      await mkOrder({ touchedAgoMs: 30 * MIN, channel: 'TAQUILLA' });
      await mkOrder({ touchedAgoMs: 30 * MIN, channel: 'INVITACION' });
      await mkOrder({ touchedAgoMs: 30 * MIN, sentAt: new Date() });
      await mkOrder({ status: 'PENDING', touchedAgoMs: 30 * MIN });
      const shop = await mkShop({ status: 'PENDING' });
      ctl.inRequest = true;
      await completeShopOrder(shop.id); // anotado como debido, sin enviar
      ctl.inRequest = false;
      ctl.queue.length = 0;
      await shopAge(shop.id, 30 * MIN);
      const r = await sweepUnsentOrderEmails({ deadline: Date.now() + 30_000, concurrency: 5 });
      expect(r.sent).toBe(2);
      expect(tickets().map((c) => c.to)).toEqual([(await reload(online.id))!.buyerEmail]);
      expect(shopMails()).toHaveLength(1);
    });
  });

  describe('cron de reconciliación: el barrido va después de reconciliar y guarda su resumen', () => {
    it('envía los emails pendientes tras reconciliar, informa de `emails` y escribe `ops_reconcile_last` (clave de sistema)', async () => {
      const o = await mkOrder({ touchedAgoMs: 30 * MIN });
      const { body } = await cron();
      expect(body.emails).toMatchObject({ examined: 1, sent: 1, failed: 0 });
      expect(tickets()).toHaveLength(1);
      expect((await reload(o.id))?.emailSentAt).toBeTruthy();

      const row = await prisma.appConfig.findUnique({ where: { key: 'ops_reconcile_last' } });
      const summary = JSON.parse(row!.value);
      expect(Object.keys(summary).sort()).toEqual(['errors', 'lastRunAt', 'processing', 'stuckOver24h', 'unknown']);
      expect(Date.now() - Date.parse(summary.lastRunAt)).toBeLessThan(60_000);
      for (const k of ['errors', 'unknown', 'processing', 'stuckOver24h']) expect(typeof summary[k], k).toBe('number');
      // Segunda pasada: nada que enviar y nada duplicado.
      expect((await cron()).body.emails).toMatchObject({ examined: 0, sent: 0 });
      expect(tickets()).toHaveLength(1);
    });

    it('con el presupuesto de tiempo agotado por la conciliación, el barrido no envía y lo deja diferido (no ensancha el cron)', async () => {
      await mkOrder({ touchedAgoMs: 30 * MIN });
      process.env.RECONCILE_TIME_BUDGET_MS = '1';
      await new Promise((r) => setTimeout(r, 5));
      const { body } = await cron();
      expect(body.emails).toMatchObject({ examined: 0, sent: 0 });
      expect(body.emails.deferred).toBeGreaterThanOrEqual(1);
      expect(tickets()).toHaveLength(0);
      delete process.env.RECONCILE_TIME_BUDGET_MS;
      expect((await cron()).body.emails.sent).toBe(1);
    });

    it('un pedido PENDING que el cron completa se envía EN el cron (inline, con su concurrencia acotada), no con after', async () => {
      const o = await mkOrder({ status: 'PENDING' });
      await prisma.order.update({ where: { id: o.id }, data: { createdAt: ago(10 * MIN) } });
      gateway.active = true;
      gateway.script(o.paymentId!, { success: true, paymentId: o.paymentId!, provider: 'fake', status: 'PAID', amount: 10, currency: 'EUR' });
      ctl.inRequest = true; // si el cron usara after, el email quedaría en la cola
      const { body } = await cron();
      expect(body.completed).toBe(1);
      expect(ctl.queue).toHaveLength(0);
      expect(tickets()).toHaveLength(1);
    });
  });

  describe('pantallas del comprador: estado real del email y reenvío con límite', () => {
    const getOrder = async (id: string, token = signOrderAccess(id)) => {
      const res = await getOrderRoute.GET(new Request(`http://localhost/api/orders/${id}?t=${encodeURIComponent(token)}`), params(id));
      return { status: res.status, body: await res.json() };
    };

    it('la API del pedido dice enviado / enviándose / reintentando / fallido y NO expone el texto del error', async () => {
      const sent = await mkOrder({ sentAt: new Date() });
      const fresh = await mkOrder();
      const retrying = await mkOrder({ attempts: 1, lastError: 'smtp_failed: ETIMEDOUT', touchedAgoMs: 30_000 });
      const exhausted = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS, lastError: 'smtp_failed: EAUTH', touchedAgoMs: 500 * MIN });
      expect((await getOrder(sent.id)).body.emailDelivery).toBe('sent');
      expect((await getOrder(fresh.id)).body.emailDelivery).toBe('sending');
      expect((await getOrder(retrying.id)).body.emailDelivery).toBe('retrying');
      const ex = await getOrder(exhausted.id);
      expect(ex.body.emailDelivery).toBe('failed');
      expect(ex.body).not.toHaveProperty('emailLastError');
      expect(JSON.stringify(ex.body)).not.toContain('EAUTH');
    });

    it('un pedido sin pagar no lleva estado de email; con un token inválido o ausente: 401', async () => {
      const pending = await mkOrder({ status: 'PENDING' });
      ctl.role = null;
      const res = await getOrder(pending.id);
      expect(res.body.emailDelivery).toBeNull();
      expect((await getOrder(pending.id, 'token-falso')).status).toBe(401);
      expect((await getOrderRoute.GET(new Request(`http://localhost/api/orders/${pending.id}`), params(pending.id))).status).toBe(401);
    });

    it('«Reenviar a mi email» (softResend con token): envía aunque esté en backoff, pasa por la concesión y consta; límite de 3 por hora y pedido → 429', async () => {
      expect(BUYER_RESEND_PER_HOUR).toBe(3); // el límite pedido: 3 por hora y pedido
      ctl.role = null;
      const o = await mkOrder({ attempts: 1, lastError: 'smtp_failed: ETIMEDOUT', touchedAgoMs: 20_000 });
      const send = (body: unknown, ip = '10.0.0.1') =>
        sendTickets(post(`http://localhost/api/orders/${o.id}/send-tickets`, body, { 'x-vercel-forwarded-for': ip }), params(o.id));
      for (let i = 0; i < BUYER_RESEND_PER_HOUR; i++) {
        const res = await send({ softResend: true, t: signOrderAccess(o.id) }, `10.0.0.${10 + i}`);
        expect(res.status, `reenvío ${i + 1}`).toBe(200);
        expect((await res.json()).success).toBe(true);
      }
      expect(tickets()).toHaveLength(BUYER_RESEND_PER_HOUR); // cada reenvío manual manda de verdad
      const over = await send({ softResend: true, t: signOrderAccess(o.id) }, '10.0.0.99');
      expect(over.status).toBe(429);
      expect((await over.json()).status).toBe('rate_limited');
      expect(tickets()).toHaveLength(BUYER_RESEND_PER_HOUR);
    });

    it('reenvío con token inválido o sin token: 401 y no se envía nada; el límite del comprador no se aplica a otro pedido', async () => {
      ctl.role = null;
      const a = await mkOrder();
      const b = await mkOrder();
      const send = (id: string, body: unknown, ip: string) => sendTickets(post(`http://localhost/api/orders/${id}/send-tickets`, body, { 'x-vercel-forwarded-for': ip }), params(id));
      expect((await send(a.id, { softResend: true, t: 'falso' }, '10.1.0.1')).status).toBe(401);
      expect((await send(a.id, { softResend: true }, '10.1.0.2')).status).toBe(401);
      expect((await send(a.id, { softResend: true, t: signOrderAccess(b.id) }, '10.1.0.3')).status).toBe(401); // el token de OTRO pedido no vale
      expect(tickets()).toHaveLength(0);
      expect((await send(b.id, { softResend: true, t: signOrderAccess(b.id) }, '10.1.0.4')).status).toBe(200);
    });

    it('el empujón sin softResend (clientes antiguos) respeta el backoff y no reenvía lo ya enviado', async () => {
      ctl.role = null;
      const sent = await mkOrder({ sentAt: new Date() });
      const waiting = await mkOrder({ attempts: 1, lastError: 'x', touchedAgoMs: 20_000 });
      const nudge = (id: string, ip: string) => sendTickets(post(`http://localhost/api/orders/${id}/send-tickets`, { t: signOrderAccess(id) }, { 'x-vercel-forwarded-for': ip }), params(id));
      expect((await (await nudge(sent.id, '10.2.0.1')).json())).toMatchObject({ success: true, alreadySent: true });
      expect((await (await nudge(waiting.id, '10.2.0.2')).json())).toMatchObject({ success: true, status: 'retrying' });
      expect(tickets()).toHaveLength(0);
    });

    it('un fallo del reenvío NO le enseña el texto del error al comprador (sí al personal)', async () => {
      ctl.role = null;
      const o = await mkOrder();
      ctl.mode = 'fail';
      const res = await sendTickets(post(`http://localhost/api/orders/${o.id}/send-tickets`, { softResend: true, t: signOrderAccess(o.id) }, { 'x-vercel-forwarded-for': '10.3.0.1' }), params(o.id));
      const body = await res.json();
      expect(body).toMatchObject({ success: false, status: 'failed' });
      expect(JSON.stringify(body)).not.toContain('ETIMEDOUT');
    });

    it('TIENDA: la API del pedido dice el estado real y el reenvío con token funciona, con límite 3/hora y 401 sin token', async () => {
      const o = await mkShop({ status: 'PENDING' });
      ctl.mode = 'fail';
      await completeShopOrder(o.id);
      ctl.mode = 'ok';
      ctl.role = null;
      const token = signShopOrderAccess(o.id);
      const get = async () => (await (await getShopOrderRoute.GET(new Request(`http://localhost/api/shop/orders/${o.id}?t=${encodeURIComponent(token)}`), params(o.id))).json()).emailDelivery;
      expect(await get()).toBe('retrying');
      const send = (t: string | null, ip: string) =>
        shopSendEmail(post(`http://localhost/api/shop/orders/${o.id}/send-email${t ? `?t=${encodeURIComponent(t)}` : ''}`, undefined, { 'x-vercel-forwarded-for': ip }), params(o.id));
      expect((await send(null, '10.4.0.1')).status).toBe(401);
      expect((await send('falso', '10.4.0.2')).status).toBe(401);
      for (let i = 0; i < BUYER_RESEND_PER_HOUR; i++) expect((await send(token, `10.4.1.${i}`)).status).toBe(200);
      expect(await get()).toBe('sent');
      expect((await send(token, '10.4.2.1')).status).toBe(429);
    });

    it('TIENDA: un pedido anterior al seguimiento (sin marcadores) no dice nada del email', async () => {
      const o = await mkShop({ status: 'PAID' });
      const body = await (await getShopOrderRoute.GET(new Request(`http://localhost/api/shop/orders/${o.id}?t=${encodeURIComponent(signShopOrderAccess(o.id))}`), params(o.id))).json();
      expect(body.emailDelivery).toBe('unknown');
    });
  });

  describe('admin: estado del email y «Reenviar email» (solo ADMIN, auditado)', () => {
    it('entradas: solo ADMIN reenvía; el personal de taquilla y los anónimos reciben 401 y no se envía nada', async () => {
      const o = await mkOrder();
      for (const role of ['TAQUILLA', null]) {
        ctl.role = role;
        expect((await adminResend(post(`http://localhost/api/admin/orders/${o.id}/resend-email`), idParams(o.id))).status).toBe(401);
      }
      expect(tickets()).toHaveLength(0);
      ctl.role = 'ADMIN';
      const res = await adminResend(post(`http://localhost/api/admin/orders/${o.id}/resend-email`), idParams(o.id));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, status: 'sent', emailDelivery: { status: 'sent', attempts: 1 } });
      expect(tickets()).toHaveLength(1);
    });

    it('el reenvío del admin salta el backoff y el tope, queda en el log de auditoría (quién y resultado) y no duplica con otro disparador', async () => {
      const o = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS, touchedAgoMs: 60_000, lastError: 'smtp_failed: EAUTH' });
      ctl.delayMs = 30;
      const [a, b] = await Promise.all([
        adminResend(post(`http://localhost/api/admin/orders/${o.id}/resend-email`), idParams(o.id)),
        sendOrderEmail('entradas', o.id, { mode: 'auto' }),
      ]);
      expect(a.status).toBe(200);
      expect(b).toMatchObject({ status: 'skipped' }); // exhausted para el automático
      expect(tickets()).toHaveLength(1);
      const audit = (console.info as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('manual_resend'));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toContain('"by":"admin:u-admin"');
      expect(audit[0]).toContain(`"orderId":"${o.id}"`);
      expect(audit[0]).toContain('"result":"sent"');
      expect(audit[0]).not.toContain(o.buyerEmail);
    });

    it('un fallo en el reenvío del admin le enseña el motivo (corto, sin datos personales) y deja el estado real', async () => {
      const o = await mkOrder();
      ctl.mode = 'fail';
      const res = await adminResend(post(`http://localhost/api/admin/orders/${o.id}/resend-email`), idParams(o.id));
      const body = await res.json();
      expect(body).toMatchObject({ success: false, status: 'failed', error: 'smtp_failed: ETIMEDOUT: Connection timeout', emailDelivery: { status: 'retrying' } });
    });

    it('tienda: solo ADMIN; reenvía por el mismo punto y deja los marcadores', async () => {
      const o = await mkShop({ status: 'PAID' });
      ctl.role = 'TAQUILLA';
      expect((await adminShopResend(post(`http://localhost/api/admin/shop-orders/${o.id}/resend-email`), idParams(o.id))).status).toBe(401);
      ctl.role = 'ADMIN';
      const res = await adminShopResend(post(`http://localhost/api/admin/shop-orders/${o.id}/resend-email`), idParams(o.id));
      expect(await res.json()).toMatchObject({ success: true, emailDelivery: { status: 'sent', attempts: 1 } });
      expect(shopMails()).toHaveLength(1);
      expect(await shopMarkers(o.id)).toEqual([`email:shop:${o.id}`, `email:shop:${o.id}:due`, `email:shop:${o.id}:try:1`].sort());
    });

    it('los listados de admin incluyen el estado real del email de cada pedido (entradas y tienda)', async () => {
      const failed = await mkOrder({ attempts: EMAIL_MAX_ATTEMPTS, lastError: 'smtp_failed: EAUTH', touchedAgoMs: 500 * MIN });
      const ok = await mkOrder({ sentAt: new Date() });
      const list = await (await adminOrders(new Request(`http://localhost/api/admin/orders?eventId=${event.id}`))).json();
      const byId = new Map<string, { emailDelivery: { status: string; lastError: string | null } }>(list.map((x: { id: string }) => [x.id, x]));
      expect(byId.get(failed.id)?.emailDelivery).toMatchObject({ status: 'exhausted', attempts: EMAIL_MAX_ATTEMPTS, lastError: 'smtp_failed: EAUTH' });
      expect(byId.get(ok.id)?.emailDelivery).toMatchObject({ status: 'sent' });

      const shop = await mkShop({ status: 'PENDING' });
      ctl.mode = 'fail';
      await completeShopOrder(shop.id);
      const shopList = await (await adminShopOrders(new Request('http://localhost/api/admin/shop-orders'))).json();
      expect(shopList.find((x: { id: string }) => x.id === shop.id).emailDelivery).toMatchObject({ status: 'retrying', attempts: 1 });
    });

    it('el filtro «Sin email» del admin solo cuenta pedidos online (la taquilla no envía email)', async () => {
      const { buildOrdersWhere } = await import('@/lib/order-filters');
      expect(buildOrdersWhere({ emailFailed: true })).toMatchObject({ status: 'COMPLETED', emailSentAt: null, channel: 'ONLINE' });
    });
  });

  describe('estado de la concesión visible en el recuento: nada se cuenta mientras se envía', () => {
    it('un envío en curso no cuenta como «sin enviar» en ops', async () => {
      const { collectOps } = await import('@/lib/ops-health');
      const before = (await collectOps())!.emailsUnsent!;
      const o = await mkOrder({ touchedAgoMs: 20 * MIN });
      expect((await collectOps())!.emailsUnsent!).toBe(before + 1);
      await claimEmailSend('entradas', o.id, { mode: 'auto' });
      expect((await collectOps())!.emailsUnsent!).toBe(before);
      await recordEmailFailure('entradas', o.id, 'smtp_failed');
      expect((await collectOps())!.emailsUnsent!).toBe(before + 1);
    });
  });
});
