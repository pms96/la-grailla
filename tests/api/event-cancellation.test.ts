import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import { gateway } from '../helpers/fake-gateway';
import { reviveOrder } from '@/lib/reconciliation/entradas';
import {
  CANCELLATION_JOB_PREFIX,
  DATE_CHANGE_JOB_PREFIX,
  MAX_MAIL_ATTEMPTS,
  MAX_REFUND_ATTEMPTS,
  cancellationMailKind,
  cancellationProgress,
  previewCancellation,
  processCancellation,
  runEventNoticeSweep,
  startCancellation,
} from '@/lib/event-cancellation';

type TestSession = { user: { id: string; role: string; email: string; modules: string[] | null } } | null;
let session: TestSession = { user: { id: 'admin-test', role: 'ADMIN', email: 'admin@test.local', modules: null } };
const mailer = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; html: string }[], fail: false }));

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/mailer', async (orig) => ({
  ...(await orig<typeof import('@/lib/mailer')>()),
  sendMail: async (p: { to: string; subject: string; html: string }) => {
    if (mailer.fail) return { success: false, transport: 'none' as const, error: 'smtp caído' };
    mailer.sent.push({ to: p.to, subject: p.subject, html: p.html });
    return { success: true, transport: 'smtp' as const };
  },
}));
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return {
    ...actual,
    getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)),
    getPaymentProvider: async (s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProvider(s)),
  };
});

const { GET: cancelGet, POST: cancelPost } = await import('@/app/api/admin/events/[id]/cancel/route');
const { PUT: updateEvent } = await import('@/app/api/admin/events/[id]/route');

/* P1-04: cancelar un evento y cambiarle la fecha con compradores. Reembolso en lote reanudable, avisos por email una sola vez, y nada de entradas
 * válidas de un evento cancelado. */

const farDeadline = () => Date.now() + 20_000;
const as = (role: string, modules: string[] | null = null): TestSession => ({ user: { id: 'u-test', role, email: 'u@test.local', modules } });

describe('cancelación de evento y cambio de fecha (P1-04)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  let n = 0;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(async () => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    session = as('ADMIN');
    gateway.reset();
    gateway.active = true;
    mailer.sent = [];
    mailer.fail = false;
    event = await createTestEvent({ maxCapacity: 500 });
    tt = await createTicketType(event.id, { price: 10, maxQuantity: 500 });
  });
  afterEach(async () => {
    await prisma.appConfig.deleteMany({ where: { key: { in: [`${CANCELLATION_JOB_PREFIX}${event.id}`, `${DATE_CHANGE_JOB_PREFIX}${event.id}`] } } });
    const orders = await prisma.order.findMany({ where: { eventId: event.id }, select: { id: true } });
    await prisma.processedWebhookEvent.deleteMany({ where: { OR: orders.flatMap((o) => [{ id: { startsWith: `event-cancel-mail:${o.id}` } }, { id: { startsWith: `event-date-mail:${o.id}` } }]) } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
  });

  /** Un pedido con una entrada. `used` deja la entrada ya escaneada. */
  async function mk(opts: { email?: string; status?: 'COMPLETED' | 'PENDING'; method?: 'CARD' | 'CASH' | 'FREE'; provider?: string | null; paymentId?: string | null; channel?: string; total?: number; used?: boolean } = {}) {
    n += 1;
    const orderStatus = opts.status ?? 'COMPLETED';
    const total = opts.total ?? 10;
    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: `Comprador ${n}`,
        buyerLastName: 'Test',
        buyerEmail: opts.email ?? `comprador-${n}-${Date.now()}@example.com`,
        totalAmount: total,
        status: orderStatus,
        paymentMethod: opts.method ?? 'CARD',
        paymentProvider: opts.provider === undefined ? 'stripe' : opts.provider,
        paymentId: opts.paymentId === undefined ? `cs_cancel_${n}_${Date.now()}` : opts.paymentId,
        channel: opts.channel ?? 'ONLINE',
        tickets: { create: { eventId: event.id, ticketTypeId: tt.id, qrCode: `QR-CANCEL-${Date.now()}-${n}`, holderName: `Comprador ${n}`, status: opts.used ? 'USED' : orderStatus === 'PENDING' ? 'PENDING' : 'VALID' } },
      },
      include: { tickets: true },
    });
    await prisma.ticketType.update({ where: { id: tt.id }, data: { soldCount: { increment: 1 } } });
    return order;
  }
  const status = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
  const ticketStatus = async (orderId: string) => (await prisma.ticket.findFirstOrThrow({ where: { orderId } })).status;
  const markerCount = (orderId: string) => prisma.processedWebhookEvent.count({ where: { id: `event-cancel-mail:${orderId}` } });
  const jobKey = () => `${CANCELLATION_JOB_PREFIX}${event.id}`;
  const readJob = async () => JSON.parse((await prisma.appConfig.findUniqueOrThrow({ where: { key: jobKey() } })).value);
  /** Salta la espera entre reintentos (lo que pasaría con el reloj): deja los fallos tal cual pero listos para volver a intentarse. */
  async function expireBackoff() {
    const job = await readJob();
    for (const f of Object.values(job.failed ?? {}) as { nextAt?: number }[]) f.nextAt = 0;
    for (const f of Object.values(job.mailFailed ?? {}) as { nextAt?: number }[]) f.nextAt = 0;
    await prisma.appConfig.update({ where: { key: jobKey() }, data: { value: JSON.stringify(job) } });
  }

  describe('vista previa', () => {
    it('cuenta lo reembolsable, lo que queda a mano, lo pendiente y a quién se puede avisar', async () => {
      await mk({ total: 20 });
      await mk({ total: 30 });
      await mk({ method: 'CASH', provider: null, paymentId: null, channel: 'TAQUILLA', total: 15 });
      await mk({ method: 'FREE', provider: 'mock', paymentId: null, total: 0 });
      await mk({ used: true, total: 12 });
      await mk({ status: 'PENDING' });
      const p = await previewCancellation(event.id);
      expect(p.refundable).toEqual({ count: 2, amount: 50 });
      expect(p.manualOrGratis).toEqual({ count: 3, amount: 27 });
      expect(p.withUsedTickets).toBe(1);
      expect(p.pending).toBe(1);
      expect(p.notifiable).toBe(4); // online completados: 2 reembolsables + gratuito + el de entradas usadas
    });
  });

  describe('cancelar el evento', () => {
    it('cierra la venta, reembolsa solo lo reembolsable, anula los pendientes, libera el aforo y avisa a cada comprador una vez', async () => {
      const a = await mk({ total: 20 });
      const b = await mk({ total: 30 });
      const cash = await mk({ method: 'CASH', provider: null, paymentId: null, channel: 'TAQUILLA', total: 15 });
      const free = await mk({ method: 'FREE', provider: 'mock', paymentId: null, total: 0 });
      const used = await mk({ used: true, total: 12 });
      const pending = await mk({ status: 'PENDING' });
      const local = await mk({ email: 'invitacion@lagrailla.local', total: 10 });

      await startCancellation(event.id, { refund: true, notify: true, startedBy: 'admin-test' });
      const progress = await processCancellation(event.id, { deadline: farDeadline() });

      expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('CANCELLED');
      for (const o of [a, b, local]) {
        expect(await status(o.id)).toBe('REFUNDED');
        expect(await ticketStatus(o.id)).toBe('REFUNDED');
      }
      expect(gateway.count('refund')).toBe(3); // a, b y el de la dirección .local (también es tarjeta); el de entradas usadas, no
      // lo que no se reembolsa solo queda como estaba
      expect(await status(cash.id)).toBe('COMPLETED');
      expect(await status(free.id)).toBe('COMPLETED');
      expect(await status(used.id)).toBe('COMPLETED');
      expect(await ticketStatus(used.id)).toBe('USED');
      expect(await status(pending.id)).toBe('CANCELLED');
      // el aforo vuelve (a, b, el .local y el pendiente liberan; cash, free y usada siguen contando)
      expect((await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).soldCount).toBe(3);
      // avisos: a, b (reembolsado), free (gratuito) y usada (a mano). Ni la taquilla, ni la dirección .local (no es un correo real).
      const to = mailer.sent.map((m) => m.to).sort();
      expect(to).toEqual([a.buyerEmail, b.buyerEmail, free.buyerEmail, used.buyerEmail].sort());
      const mailA = mailer.sent.find((m) => m.to === a.buyerEmail)!;
      expect(mailA.subject).toContain('Evento cancelado');
      expect(mailA.html).toContain('20,00 €');
      expect(mailA.html).toMatch(/hemos devuelto/i);
      expect(mailer.sent.find((m) => m.to === used.buyerEmail)!.html).toMatch(/pendiente de devolución/i);
      expect(mailer.sent.find((m) => m.to === free.buyerEmail)!.html).toMatch(/gratuito/i);
      expect(progress?.done).toBe(true);
      expect(progress?.manual.map((m) => m.orderId)).toContain(used.id);
    });

    it('es idempotente: volver a lanzar el trabajo no reembolsa ni avisa dos veces', async () => {
      const a = await mk({ total: 20 });
      await mk({ total: 30 });
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      await processCancellation(event.id, { deadline: farDeadline() });
      const refunds = gateway.count('refund');
      const mails = mailer.sent.length;
      await processCancellation(event.id, { deadline: farDeadline() });
      await runEventNoticeSweep({ deadline: farDeadline() });
      expect(gateway.count('refund')).toBe(refunds);
      expect(mailer.sent).toHaveLength(mails);
      expect(await markerCount(a.id)).toBe(1);
    });

    it('un fallo del reembolso se reintenta y, tras los intentos, queda «a mano» y se avisa al comprador de eso (no de que se le devolvió)', async () => {
      const a = await mk({ total: 20 });
      gateway.refundResult = { success: false, error: 'charge_already_disputed' };
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      let progress = await processCancellation(event.id, { deadline: farDeadline() });
      expect(progress?.done).toBe(false);
      expect(await status(a.id)).toBe('COMPLETED');
      expect(mailer.sent).toHaveLength(0); // mientras reintenta no se le dice nada falso
      for (let i = 1; i < MAX_REFUND_ATTEMPTS; i++) {
        await expireBackoff();
        progress = await processCancellation(event.id, { deadline: farDeadline() });
      }
      expect(gateway.count('refund')).toBe(MAX_REFUND_ATTEMPTS);
      expect(progress?.done).toBe(true);
      expect(progress?.manual.some((m) => m.orderId === a.id && /charge_already_disputed/.test(m.reason))).toBe(true);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].html).toMatch(/pendiente de devolución/i);
      expect(mailer.sent[0].html).not.toMatch(/hemos devuelto/i);
    });

    it('si el reembolso falla una vez y funciona después, termina bien y avisa del reembolso', async () => {
      const a = await mk({ total: 20 });
      gateway.refundResult = { success: false, error: 'timeout' };
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      await processCancellation(event.id, { deadline: farDeadline() });
      gateway.refundResult = { success: true, refundId: 're_ok' };
      await expireBackoff();
      const progress = await processCancellation(event.id, { deadline: farDeadline() });
      expect(await status(a.id)).toBe('REFUNDED');
      expect(progress?.done).toBe(true);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].html).toMatch(/hemos devuelto/i);
    });

    it('tras un fallo el reembolso espera su turno: no se reintenta en la pasada siguiente y el estado dice cuándo volverá a intentarse', async () => {
      const a = await mk({ total: 20 });
      gateway.refundResult = { success: false, error: 'timeout' };
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      const first = await processCancellation(event.id, { deadline: farDeadline() });
      expect(gateway.count('refund')).toBe(1);
      expect(first?.retryAt).not.toBeNull();
      expect(new Date(first!.retryAt!).getTime()).toBeGreaterThan(Date.now());
      // el diálogo sondea cada segundo y el cron cada pocos minutos: ninguna de esas pasadas agota los intentos
      for (let i = 0; i < 5; i++) await processCancellation(event.id, { deadline: farDeadline() });
      await runEventNoticeSweep({ deadline: farDeadline() });
      expect(gateway.count('refund')).toBe(1);
      expect((await readJob()).failed[a.id].attempts).toBe(1);
      expect(mailer.sent).toHaveLength(0);
    });

    it('una llamada a la pasarela que no responde a tiempo cuenta como fallo y no bloquea el lote', async () => {
      const a = await mk({ total: 20 });
      gateway.refundDelayMs = 400;
      await startCancellation(event.id, { refund: true, notify: false, startedBy: null });
      const t0 = Date.now();
      const progress = await processCancellation(event.id, { deadline: farDeadline(), callCapMs: 60 });
      expect(Date.now() - t0).toBeLessThan(350);
      const failed = (await readJob()).failed[a.id];
      expect(failed.attempts).toBe(1);
      expect(failed.error).toMatch(/tiempo agotado/);
      expect(progress?.retryAt).not.toBeNull();
      await new Promise((r) => setTimeout(r, 500)); // deja terminar la llamada en vuelo antes de limpiar
    });

    it('sin reembolso automático no se devuelve nada y se avisa de que lo gestiona el organizador', async () => {
      const a = await mk({ total: 20 });
      await startCancellation(event.id, { refund: false, notify: true, startedBy: null });
      const progress = await processCancellation(event.id, { deadline: farDeadline() });
      expect(gateway.count('refund')).toBe(0);
      expect(await status(a.id)).toBe('COMPLETED');
      expect(progress?.done).toBe(true);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].html).toMatch(/pendiente de devolución/i);
    });

    it('sin avisos por email no se envía ninguno', async () => {
      await mk({ total: 20 });
      await startCancellation(event.id, { refund: true, notify: false, startedBy: null });
      const progress = await processCancellation(event.id, { deadline: farDeadline() });
      expect(mailer.sent).toHaveLength(0);
      expect(progress?.done).toBe(true);
    });

    it('si el SMTP falla, el aviso se libera y se reintenta en la siguiente pasada sin duplicar; y no se reintenta para siempre', async () => {
      const a = await mk({ total: 20 });
      mailer.fail = true;
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      let progress = await processCancellation(event.id, { deadline: farDeadline() });
      expect(await status(a.id)).toBe('REFUNDED'); // el reembolso no depende del correo
      expect(await markerCount(a.id)).toBe(0); // marcador liberado para reintentar
      expect(progress?.done).toBe(false);
      expect(progress?.retryAt).not.toBeNull();
      mailer.fail = false;
      // con la espera sin cumplir no se reenvía (el SMTP caído no se martillea cada segundo)
      await processCancellation(event.id, { deadline: farDeadline() });
      expect(mailer.sent).toHaveLength(0);
      await expireBackoff();
      progress = await processCancellation(event.id, { deadline: farDeadline() });
      expect(mailer.sent).toHaveLength(1);
      expect(progress?.done).toBe(true);
    });

    it('con el SMTP caído para siempre el aviso no se reintenta eternamente: se da por fallido y se le dice al admin quién se quedó sin aviso', async () => {
      await mk({ total: 20 });
      mailer.fail = true;
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      let progress = await processCancellation(event.id, { deadline: farDeadline() });
      for (let i = 1; i < MAX_MAIL_ATTEMPTS; i++) {
        expect(progress?.done).toBe(false);
        await expireBackoff();
        progress = await processCancellation(event.id, { deadline: farDeadline() });
      }
      expect(mailer.sent).toHaveLength(0);
      expect(progress?.done).toBe(true);
      expect(progress?.emailsRemaining).toBe(0);
      expect(progress?.emailsFailed).toBe(1);
      expect(progress?.manual.some((m) => /No se pudo enviar el aviso/.test(m.reason))).toBe(true);
    });

    it('un lote que se queda sin tiempo no hace nada y el siguiente (o el cron) lo continúa', async () => {
      const a = await mk({ total: 20 });
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      const none = await processCancellation(event.id, { deadline: Date.now() - 1 });
      expect(none?.done).toBe(false);
      expect(await status(a.id)).toBe('COMPLETED');
      const sweep = await runEventNoticeSweep({ deadline: farDeadline() });
      expect(sweep.cancellations).toBeGreaterThanOrEqual(1);
      expect(await status(a.id)).toBe('REFUNDED');
      expect((await cancellationProgress(event.id))?.done).toBe(true);
    });

    it('si se vuelve a publicar el evento, el trabajo se cierra sin reembolsar nada más', async () => {
      const a = await mk({ total: 20 });
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      await prisma.event.update({ where: { id: event.id }, data: { status: 'PUBLISHED' } });
      const progress = await processCancellation(event.id, { deadline: farDeadline() });
      expect(progress?.done).toBe(true);
      expect(await status(a.id)).toBe('COMPLETED');
      expect(gateway.count('refund')).toBe(0);
    });

    it('un pedido «reembolsado» con entradas aún activas (reembolso a medias) NO recibe «hemos devuelto» y queda en la lista a mano', async () => {
      const half = await mk({ total: 20 });
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      await prisma.order.update({ where: { id: half.id }, data: { status: 'REFUNDED' } }); // lo marca el reembolso ya en el trabajo; sus entradas siguen VALID
      const progress = await processCancellation(event.id, { deadline: farDeadline() });
      expect(mailer.sent).toHaveLength(0);
      expect(gateway.count('refund')).toBe(0);
      expect(progress?.manual.some((m) => m.orderId === half.id && /a medias/.test(m.reason))).toBe(true);
    });

    it('un pedido reembolsado ANTES de cancelar el evento no recibe un segundo aviso', async () => {
      const old = await mk({ total: 20 });
      await prisma.order.update({ where: { id: old.id }, data: { status: 'REFUNDED', updatedAt: new Date(Date.now() - 3 * 86_400_000) } });
      await prisma.ticket.updateMany({ where: { orderId: old.id }, data: { status: 'REFUNDED' } });
      const fresh = await mk({ total: 30 });
      await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
      const progress = await processCancellation(event.id, { deadline: farDeadline() });
      expect(mailer.sent.map((m) => m.to)).toEqual([fresh.buyerEmail]);
      expect(progress?.refunded).toBe(1);
      expect(progress?.done).toBe(true);
    });

    it('el barrido del cron encuentra un trabajo nuevo aunque haya muchas filas de trabajos ya terminados', async () => {
      const finished = JSON.stringify({ v: 1, refund: true, notify: true, startedAt: '2020-01-01T00:00:00.000Z', startedBy: null, doneAt: '2020-01-02T00:00:00.000Z', failed: {}, mailFailed: {} });
      const keys = Array.from({ length: 60 }, (_, i) => `${CANCELLATION_JOB_PREFIX}0000-viejo-${i}`);
      await prisma.appConfig.createMany({ data: keys.map((key) => ({ key, value: finished, label: key, group: 'system' })) });
      try {
        const a = await mk({ total: 20 });
        await startCancellation(event.id, { refund: true, notify: true, startedBy: null });
        await runEventNoticeSweep({ deadline: farDeadline() });
        expect(await status(a.id)).toBe('REFUNDED');
      } finally {
        await prisma.appConfig.deleteMany({ where: { key: { in: keys } } });
      }
    });

    it('cancellationMailKind: solo avisa cuando el estado del dinero ya es final', () => {
      const base = { id: 'o1', paymentMethod: 'CARD', paymentProvider: 'stripe', paymentId: 'cs', totalAmount: 10, hasUsed: false };
      expect(cancellationMailKind({ ...base, status: 'COMPLETED' }, { refund: true, failed: {} })).toBeNull(); // aún falta reembolsarlo
      expect(cancellationMailKind({ ...base, status: 'REFUNDED' }, { refund: true, failed: {} })).toBe('refunded');
      expect(cancellationMailKind({ ...base, status: 'COMPLETED' }, { refund: false, failed: {} })).toBe('manual');
      expect(cancellationMailKind({ ...base, status: 'COMPLETED' }, { refund: true, failed: { o1: { attempts: MAX_REFUND_ATTEMPTS, error: 'x' } } })).toBe('manual');
      expect(cancellationMailKind({ ...base, status: 'COMPLETED', totalAmount: 0 }, { refund: true, failed: {} })).toBe('free');
      expect(cancellationMailKind({ ...base, status: 'COMPLETED', hasUsed: true }, { refund: true, failed: {} })).toBe('manual');
      expect(cancellationMailKind({ ...base, status: 'CANCELLED' }, { refund: true, failed: {} })).toBeNull();
      expect(cancellationMailKind({ ...base, status: 'REFUNDED', hasActive: true }, { refund: true, failed: {} })).toBeNull(); // reembolso en vuelo o a medias
      expect(cancellationMailKind({ ...base, status: 'REFUNDED', hasActive: false }, { refund: true, failed: {} })).toBe('refunded');
    });
  });

  describe('pago tardío sobre un evento cancelado', () => {
    it('un pago que llega tarde sobre un pedido anulado NO reanima entradas de un evento cancelado', async () => {
      const o = await mk({ status: 'COMPLETED' });
      await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED' } });
      await prisma.ticket.updateMany({ where: { orderId: o.id }, data: { status: 'CANCELLED' } });
      await prisma.event.update({ where: { id: event.id }, data: { status: 'CANCELLED' } });
      expect(await reviveOrder(o.id)).toBe('no_capacity');
      expect(await status(o.id)).toBe('CANCELLED');
    });

    it('con el evento publicado, el mismo pedido sí se reanima (la diferencia es el estado del evento)', async () => {
      const o = await mk({ status: 'COMPLETED' });
      await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED' } });
      await prisma.ticket.updateMany({ where: { orderId: o.id }, data: { status: 'CANCELLED' } });
      expect(await reviveOrder(o.id)).toBe('revived');
      expect(await status(o.id)).toBe('COMPLETED');
    });
  });

  describe('API de cancelación', () => {
    const call = (id: string, body: unknown) =>
      cancelPost(new Request(`http://localhost/api/admin/events/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    const get = (id: string) => cancelGet(new Request(`http://localhost/api/admin/events/${id}/cancel`), { params: Promise.resolve({ id }) });

    it('solo un ADMIN puede ver la vista previa y cancelar', async () => {
      for (const s of [null, as('TAQUILLA'), as('USER')]) {
        session = s;
        expect((await get(event.id)).status).toBe(401);
        expect((await call(event.id, { action: 'start' })).status).toBe(401);
      }
      expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).not.toBe('CANCELLED');
    });

    it('GET devuelve la vista previa; POST start cancela y procesa; POST continue sin trabajo es 404', async () => {
      const a = await mk({ total: 20 });
      expect((await call(event.id, { action: 'continue' })).status).toBe(404);
      const preview = await (await get(event.id)).json();
      expect(preview.preview.refundable).toEqual({ count: 1, amount: 20 });
      expect(preview.progress).toBeNull();
      const res = await call(event.id, { action: 'start', refund: true, notify: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.progress.done).toBe(true);
      expect(body.progress.refunded).toBe(1);
      expect(await status(a.id)).toBe('REFUNDED');
    });

    it('un evento que no existe es 404', async () => {
      expect((await get('no-existe')).status).toBe(404);
      expect((await call('no-existe', { action: 'start' })).status).toBe(404);
    });
  });

  describe('PUT del evento: flujos con compradores', () => {
    const put = (id: string, body: unknown) =>
      updateEvent(new Request(`http://localhost/api/admin/events/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    const eventDate = async () => (await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).date;

    it('cancelar con un simple cambio de estado, teniendo pedidos, se rechaza y manda al flujo de cancelación', async () => {
      await mk();
      const res = await put(event.id, { status: 'CANCELLED' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'use_cancel_flow' });
      expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).not.toBe('CANCELLED');
    });

    it('sin pedidos, cancelar con el cambio de estado sigue funcionando', async () => {
      expect((await put(event.id, { status: 'CANCELLED' })).status).toBe(200);
      expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('CANCELLED');
    });

    it('cambiar la fecha con compradores pide confirmación y no cambia nada hasta tenerla', async () => {
      await mk();
      const before = await eventDate();
      const res = await put(event.id, { date: '2031-05-10T22:00' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'date_change_needs_confirmation', buyers: 1 });
      expect((await eventDate()).getTime()).toBe(before.getTime());
    });

    it('«cambiar y avisar» cambia la fecha y envía a cada comprador online un email con la fecha anterior y la nueva, una sola vez', async () => {
      const a = await mk();
      const b = await mk();
      await mk({ channel: 'TAQUILLA', method: 'CASH', provider: null, paymentId: null });
      const res = await put(event.id, { date: '2031-05-10T22:00', notifyDateChange: true });
      expect(res.status).toBe(200);
      expect((await eventDate()).toISOString()).toBe('2031-05-10T20:00:00.000Z'); // 22:00 de Madrid (verano)
      expect(mailer.sent.map((m) => m.to).sort()).toEqual([a.buyerEmail, b.buyerEmail].sort());
      expect(mailer.sent[0].subject).toContain('Cambio de fecha');
      expect(mailer.sent[0].html).toMatch(/Antes:/);
      expect(mailer.sent[0].html).toMatch(/Ahora:/);
      expect(mailer.sent[0].html).toMatch(/10 de mayo de 2031/);
      await runEventNoticeSweep({ deadline: farDeadline() }); // el cron no reenvía
      expect(mailer.sent).toHaveLength(2);
    });

    it('«cambiar sin avisar» cambia la fecha y no envía nada', async () => {
      await mk();
      expect((await put(event.id, { date: '2031-05-10T22:00', notifyDateChange: false })).status).toBe(200);
      expect(mailer.sent).toHaveLength(0);
      expect(await prisma.appConfig.count({ where: { key: `${DATE_CHANGE_JOB_PREFIX}${event.id}` } })).toBe(0);
    });

    it('sin compradores, o reenviando la misma fecha, no se pide ninguna confirmación', async () => {
      expect((await put(event.id, { date: '2031-05-10T22:00' })).status).toBe(200);
      await mk();
      expect((await put(event.id, { date: '2031-05-10T22:00' })).status).toBe(200);
      expect(mailer.sent).toHaveLength(0);
    });

    it('un evento cancelado con el flujo de cancelación no se puede volver a publicar con un cambio de estado', async () => {
      await mk({ total: 20 });
      await startCancellation(event.id, { refund: true, notify: false, startedBy: null });
      const res = await put(event.id, { status: 'PUBLISHED' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'cancelled_event_locked' });
      expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('CANCELLED');
    });

    it('si el aviso anterior no terminó y la fecha cambia otra vez, los pendientes reciben como «antes» la fecha original y un aviso nuevo', async () => {
      await mk();
      const original = (await eventDate()).toISOString();
      mailer.fail = true; // el aviso del primer cambio queda sin terminar
      await put(event.id, { date: '2031-05-10T22:00', notifyDateChange: true });
      const first = JSON.parse((await prisma.appConfig.findUniqueOrThrow({ where: { key: `${DATE_CHANGE_JOB_PREFIX}${event.id}` } })).value);
      expect(first.doneAt).toBeNull();
      await put(event.id, { date: '2031-05-11T22:00', notifyDateChange: true });
      const second = JSON.parse((await prisma.appConfig.findUniqueOrThrow({ where: { key: `${DATE_CHANGE_JOB_PREFIX}${event.id}` } })).value);
      expect(second.oldDate).toBe(original);
      expect(second.tag).not.toBe(first.tag);
    });

    it('si cambia otra vez la fecha, se avisa otra vez (cada cambio es un aviso distinto)', async () => {
      await mk();
      await put(event.id, { date: '2031-05-10T22:00', notifyDateChange: true });
      await put(event.id, { date: '2031-05-11T22:00', notifyDateChange: true });
      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent[1].html).toMatch(/11 de mayo de 2031/);
    });
  });
});
