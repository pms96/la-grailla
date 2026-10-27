import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import {
  EMAIL_BACKOFF_MS,
  EMAIL_FAILED_WINDOW_MS,
  EMAIL_PENDING_STALE_MS,
  EMAIL_LEASE_MS,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_WINDOW_MS,
  backoffAfter,
  claimEmailSend,
  countEmailBacklog,
  deriveEmailState,
  getEmailState,
  getEmailStates,
  listUnsent,
  recordEmailFailure,
  recordEmailSent,
  sanitizeEmailError,
  trackEmail,
} from '@/lib/email-delivery';
import { cleanupAllStaleEntries } from '@/lib/waiting-room';
import { cleanupTestEvent, createTestEvent } from '../helpers/fixtures';
import { buyerEmailView } from '@/lib/order-email';

/* P0-08: la capa de estado de entrega del email (lib/email-delivery.ts) con la BD real. Entradas usa las columnas de Order; la tienda, filas
 * marcadoras en ProcessedWebhookEvent. La misma batería de reglas para las dos: concesión atómica, backoff, tope de intentos, relevo de una
 * concesión caducada, el listado de pendientes y el recuento del bloque `ops`. */

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

describe('email-delivery (P0-08)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  const orderIds: string[] = [];
  const shopIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    event = await createTestEvent();
  });
  afterAll(async () => {
    await prisma.processedWebhookEvent.deleteMany({ where: { id: { startsWith: 'email:shop:' } } });
    await prisma.shopOrder.deleteMany({ where: { id: { in: shopIds } } });
    await cleanupTestEvent(event.id);
  });
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /** Pedido de entradas con el estado de email indicado. `touchedAgoMs` fija `updatedAt` (la hora del último intento). */
  async function mkOrder(over: { eventId?: string; status?: 'PENDING' | 'COMPLETED' | 'CANCELLED'; channel?: string; attempts?: number; lastError?: string | null; sentAt?: Date | null; touchedAgoMs?: number } = {}) {
    const o = await prisma.order.create({
      data: {
        eventId: over.eventId ?? event.id,
        buyerName: 'Email',
        buyerLastName: 'Test',
        buyerEmail: `email-${Date.now()}-${n++}@example.com`,
        totalAmount: 10,
        status: over.status ?? 'COMPLETED',
        channel: over.channel ?? 'ONLINE',
        emailAttempts: over.attempts ?? 0,
        emailLastError: over.lastError ?? null,
        emailSentAt: over.sentAt ?? null,
      },
    });
    orderIds.push(o.id);
    if (over.touchedAgoMs !== undefined) await setTouched(o.id, over.touchedAgoMs);
    return o;
  }
  // `updatedAt` lo pone Prisma en cada escritura: para fijarlo se escribe en SQL (sin pasar por @updatedAt).
  // Si el pedido tiene una concesión (`sending:<epoch>`), su hora se retrasa igual: es la que decide cuándo caduca.
  const setTouched = (id: string, agoMs: number) =>
    prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = ${ago(agoMs)}, "emailLastError" = CASE WHEN "emailLastError" LIKE 'sending:%' THEN 'sending:' || ${String(Date.now() - agoMs)} ELSE "emailLastError" END WHERE "id" = ${id}`;
  const reloadOrder = (id: string) => prisma.order.findUnique({ where: { id } });

  async function mkShop(over: { status?: 'PENDING' | 'PAID' | 'CANCELLED' | 'SHIPPED' } = {}) {
    const o = await prisma.shopOrder.create({
      data: { buyerName: 'Tienda', buyerEmail: `shop-${Date.now()}-${n++}@example.com`, shippingAddress: 'x', shippingCity: 'x', shippingZip: '28001', totalAmount: 10, status: over.status ?? 'PAID' },
    });
    shopIds.push(o.id);
    return o;
  }
  const markers = async (id: string) => (await prisma.processedWebhookEvent.findMany({ where: { id: { startsWith: `email:shop:${id}` } } })).map((r) => r.id).sort();
  /** Retrasa TODOS los marcadores del pedido (como si el intento y el pago fueran de hace `agoMs`). */
  const shopSetAge = (id: string, agoMs: number, only?: string) =>
    prisma.processedWebhookEvent.updateMany({ where: { id: only ? `email:shop:${id}${only}` : { startsWith: `email:shop:${id}` } }, data: { processedAt: ago(agoMs) } });

  // Las dos implementaciones se prueban con las MISMAS reglas.
  const kinds = [
    {
      kind: 'entradas' as const,
      make: async (o: { attempts?: number; touchedAgoMs?: number } = {}) => (await mkOrder(o)).id,
      /** Deja el pedido como si el último intento hubiera sido hace `agoMs` (la hora que usa el backoff). */
      touch: (id: string, agoMs: number) => setTouched(id, agoMs),
    },
    {
      kind: 'tienda' as const,
      make: async (o: { attempts?: number; touchedAgoMs?: number } = {}) => {
        const id = (await mkShop()).id;
        await trackEmail('tienda', id);
        for (let i = 1; i <= (o.attempts ?? 0); i++) await prisma.processedWebhookEvent.create({ data: { id: `email:shop:${id}:try:${i}` } });
        if (o.touchedAgoMs !== undefined) await shopSetAge(id, o.touchedAgoMs);
        return id;
      },
      touch: (id: string, agoMs: number) => shopSetAge(id, agoMs).then(() => undefined),
    },
  ];

  describe.each(kinds)('$kind', ({ kind, make, touch }) => {
    it('CONCESIÓN: de 12 disparadores simultáneos solo UNO reclama el envío y el resto recibe in_progress', async () => {
      const id = await make();
      const results = await Promise.all(Array.from({ length: 12 }, () => claimEmailSend(kind, id, { mode: 'auto' })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === 'in_progress')).toHaveLength(11);
      expect((await getEmailState(kind, id))?.status).toBe('sending');
      expect((await getEmailState(kind, id))?.attempts).toBe(1);
    });

    it('mientras hay un envío en curso, ni el reenvío manual ni el barrido lo pisan', async () => {
      const id = await make();
      expect((await claimEmailSend(kind, id, { mode: 'auto' })).ok).toBe(true);
      expect(await claimEmailSend(kind, id, { mode: 'manual', resend: true })).toEqual({ ok: false, reason: 'in_progress' });
      expect(await claimEmailSend(kind, id, { mode: 'auto' })).toEqual({ ok: false, reason: 'in_progress' });
    });

    it('un fallo anota el intento; un reintento AUTOMÁTICO inmediato espera al backoff; pasado el backoff se concede', async () => {
      const id = await make();
      expect(await claimEmailSend(kind, id, { mode: 'auto' })).toMatchObject({ ok: true, attempt: 1 });
      const failed = await recordEmailFailure(kind, id, 'ETIMEDOUT: Connection timeout');
      expect(failed).toEqual({ attempts: 1, exhausted: false });
      expect((await getEmailState(kind, id))?.status).toBe('retrying');

      expect(await claimEmailSend(kind, id, { mode: 'auto' })).toEqual({ ok: false, reason: 'backoff' });
      await touch(id, EMAIL_BACKOFF_MS[0] - 10_000); // aún faltan 10 s
      expect(await claimEmailSend(kind, id, { mode: 'auto' })).toEqual({ ok: false, reason: 'backoff' });
      await touch(id, EMAIL_BACKOFF_MS[0] + 1_000);
      expect(await claimEmailSend(kind, id, { mode: 'auto' })).toMatchObject({ ok: true, attempt: 2 });
    });

    it('el backoff crece con los intentos (2, 5, 15, 60 y 180 min): tras el intento n no se concede hasta pasada su espera', async () => {
      for (let attempts = 1; attempts <= 5; attempts++) {
        const id = await make({ attempts, touchedAgoMs: EMAIL_BACKOFF_MS[attempts - 1] - 5_000 });
        expect(await claimEmailSend(kind, id, { mode: 'auto' }), `intento ${attempts}, antes de la espera`).toEqual({ ok: false, reason: 'backoff' });
        await touch(id, EMAIL_BACKOFF_MS[attempts - 1] + 5_000);
        expect(await claimEmailSend(kind, id, { mode: 'auto' }), `intento ${attempts}, pasada la espera`).toMatchObject({ ok: true, attempt: attempts + 1 });
      }
      expect(EMAIL_BACKOFF_MS.map((ms) => ms / MIN)).toEqual([2, 5, 15, 60, 180]);
    });

    it('éxito tras N fallos: queda enviado, ya no se reclama en automático y el reenvío manual sí puede', async () => {
      const id = await make({ attempts: 2, touchedAgoMs: 10 * MIN });
      expect(await claimEmailSend(kind, id, { mode: 'auto' })).toMatchObject({ ok: true, attempt: 3 });
      await recordEmailSent(kind, id);
      const st = await getEmailState(kind, id);
      expect(st).toMatchObject({ status: 'sent', attempts: 3 });
      expect(st?.sentAt).toBeInstanceOf(Date);
      expect(await claimEmailSend(kind, id, { mode: 'auto' })).toEqual({ ok: false, reason: 'already_sent' });
      expect(await claimEmailSend(kind, id, { mode: 'manual' })).toEqual({ ok: false, reason: 'already_sent' });
      expect(await claimEmailSend(kind, id, { mode: 'manual', resend: true })).toMatchObject({ ok: true });
    });

    it('TOPE: al llegar a 6 intentos queda agotado (exhausted); el automático ya no lo reclama y el manual sí', async () => {
      const id = await make({ attempts: EMAIL_MAX_ATTEMPTS - 1, touchedAgoMs: 200 * MIN });
      expect(await claimEmailSend(kind, id, { mode: 'auto' })).toMatchObject({ ok: true, attempt: EMAIL_MAX_ATTEMPTS });
      expect(await recordEmailFailure(kind, id, 'boom')).toEqual({ attempts: EMAIL_MAX_ATTEMPTS, exhausted: true });
      expect((await getEmailState(kind, id))?.status).toBe('exhausted');
      await touch(id, 1000 * MIN);
      expect(await claimEmailSend(kind, id, { mode: 'auto' })).toEqual({ ok: false, reason: 'exhausted' });
      expect(await claimEmailSend(kind, id, { mode: 'manual', resend: true })).toMatchObject({ ok: true, attempt: EMAIL_MAX_ATTEMPTS + 1 });
    });

    it('una concesión CADUCADA (la función murió enviando) se releva: el siguiente disparador la toma; una viva no', async () => {
      const id = await make();
      expect((await claimEmailSend(kind, id, { mode: 'manual' })).ok).toBe(true);
      await touch(id, EMAIL_LEASE_MS - 20_000);
      expect(await claimEmailSend(kind, id, { mode: 'manual' })).toEqual({ ok: false, reason: 'in_progress' });
      await touch(id, EMAIL_LEASE_MS + 5_000);
      expect(await claimEmailSend(kind, id, { mode: 'manual' })).toMatchObject({ ok: true, attempt: 2 });
    });

    it('el relevo de una concesión caducada también es atómico: de 10 simultáneos, uno', async () => {
      const id = await make();
      await claimEmailSend(kind, id, { mode: 'manual' });
      await touch(id, EMAIL_LEASE_MS + 5_000);
      const results = await Promise.all(Array.from({ length: 10 }, () => claimEmailSend(kind, id, { mode: 'manual' })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });

    it('un pedido que no está pagado (o no existe) no se puede reclamar', async () => {
      expect(await claimEmailSend(kind, 'no-existe', { mode: 'manual' })).toEqual({ ok: false, reason: 'not_found' });
      const pending = kind === 'entradas' ? (await mkOrder({ status: 'PENDING' })).id : (await mkShop({ status: 'PENDING' })).id;
      expect(await claimEmailSend(kind, pending, { mode: 'manual' })).toEqual({ ok: false, reason: 'not_sendable' });
      const cancelled = kind === 'entradas' ? (await mkOrder({ status: 'CANCELLED' })).id : (await mkShop({ status: 'CANCELLED' })).id;
      expect(await claimEmailSend(kind, cancelled, { mode: 'manual' })).toEqual({ ok: false, reason: 'not_sendable' });
    });

    it('getEmailStates devuelve el estado de varios pedidos con una consulta y omite los que no existen', async () => {
      const a = await make();
      const b = await make({ attempts: 1, touchedAgoMs: 10 * MIN });
      const map = await getEmailStates(kind, [a, b, 'no-existe']);
      expect([...map.keys()].sort()).toEqual([a, b].sort());
      expect(map.get(a)?.status).toBe('pending');
      expect(map.get(b)?.status).toBe('retrying');
    });

    it('listUnsent: devuelve a los que les toca (pendientes de más de 2 min y reintentos vencidos), no a los recientes, en backoff, enviados ni agotados', async () => {
      const due0 = await make({ touchedAgoMs: 3 * MIN }); // sin intentos, de hace 3 min
      const fresh0 = await make({ touchedAgoMs: 30_000 }); // sin intentos, de hace 30 s: el envío normal está en marcha
      const due1 = await make({ attempts: 1, touchedAgoMs: 3 * MIN });
      const wait1 = await make({ attempts: 1, touchedAgoMs: 1 * MIN });
      const due3 = await make({ attempts: 3, touchedAgoMs: 20 * MIN });
      const wait3 = await make({ attempts: 3, touchedAgoMs: 10 * MIN });
      const spent = await make({ attempts: EMAIL_MAX_ATTEMPTS, touchedAgoMs: 1000 * MIN });
      const done = await make({ touchedAgoMs: 30 * MIN });
      await claimEmailSend(kind, done, { mode: 'auto' });
      await recordEmailSent(kind, done);
      await touch(done, 30 * MIN);

      const listed = (await listUnsent(kind, { limit: 500 })).map((r) => r.id);
      for (const id of [due0, due1, due3]) expect(listed, id).toContain(id);
      for (const id of [fresh0, wait1, wait3, spent, done]) expect(listed, id).not.toContain(id);
      expect((await listUnsent(kind, { limit: 500 })).find((r) => r.id === due3)?.attempts).toBe(3);
    });

    it('listUnsent respeta el límite y atiende primero a los más antiguos', async () => {
      const old = await make({ touchedAgoMs: 90 * MIN });
      const mid = await make({ touchedAgoMs: 60 * MIN });
      await make({ touchedAgoMs: 30 * MIN });
      const all = await listUnsent(kind, { limit: 1000 });
      const idx = (id: string) => all.findIndex((r) => r.id === id);
      expect(idx(old)).toBeLessThan(idx(mid));
      expect(await listUnsent(kind, { limit: 2 })).toHaveLength(2);
    });

    it('un pedido más viejo que la ventana (7 días) no se barre ni se cuenta: no se resucita lo antiguo', async () => {
      const ancient = await make({ attempts: 1, touchedAgoMs: EMAIL_WINDOW_MS + 60 * MIN });
      expect((await listUnsent(kind, { limit: 1000 })).map((r) => r.id)).not.toContain(ancient);
      // …y su pantalla ya no promete reintentos: no habrá más intentos automáticos.
      expect((await getEmailState(kind, ancient))?.status).toBe('exhausted');
    });

    it('countEmailBacklog: cuenta sin enviar (con fallo previo o >10 min sin intentar), agotados aparte, y no cuenta lo que se está enviando ni lo enviado', async () => {
      const before = await countEmailBacklog(kind);
      await make({ touchedAgoMs: 11 * MIN }); // sin intentos y de hace 11 min → sin enviar
      await make({ touchedAgoMs: 5 * MIN }); // sin intentos y reciente → aún no
      await make({ attempts: 1, touchedAgoMs: 30_000 }); // ya falló una vez → sin enviar
      await make({ attempts: EMAIL_MAX_ATTEMPTS, touchedAgoMs: 100 * MIN }); // agotado
      const inFlight = await make({ touchedAgoMs: 20 * MIN });
      await claimEmailSend(kind, inFlight, { mode: 'auto' }); // enviándose ahora
      const sent = await make({ touchedAgoMs: 20 * MIN });
      await claimEmailSend(kind, sent, { mode: 'auto' });
      await recordEmailSent(kind, sent);
      const after = await countEmailBacklog(kind);
      expect(after.unsent - before.unsent).toBe(2);
      expect(after.failed - before.failed).toBe(1);
    });
  });

  describe('entradas: columnas de Order', () => {
    it('la concesión es `sending:<epoch>` en emailLastError; un fallo deja un texto corto SIN la marca; el éxito la limpia', async () => {
      const o = await mkOrder();
      const t0 = Date.now();
      await claimEmailSend('entradas', o.id, { mode: 'auto' });
      const claimed = await reloadOrder(o.id);
      expect(claimed?.emailLastError).toMatch(/^sending:\d+$/);
      expect(Number(claimed?.emailLastError?.slice(8))).toBeGreaterThanOrEqual(t0);
      expect(claimed?.emailAttempts).toBe(1);

      await recordEmailFailure('entradas', o.id, 'smtp_failed: ETIMEDOUT');
      expect((await reloadOrder(o.id))?.emailLastError).toBe('smtp_failed: ETIMEDOUT');

      await setTouched(o.id, 10 * MIN);
      await claimEmailSend('entradas', o.id, { mode: 'manual' });
      await recordEmailSent('entradas', o.id);
      const done = await reloadOrder(o.id);
      expect(done?.emailLastError).toBeNull();
      expect(done?.emailSentAt).toBeInstanceOf(Date);
      expect(done?.emailAttempts).toBe(2);
    });

    it('un envío con la columna emailSentAt ya escrita (sin pasar por la capa, p. ej. un pedido antiguo) no se reclama', async () => {
      const o = await mkOrder({ sentAt: new Date() });
      expect(await claimEmailSend('entradas', o.id, { mode: 'auto' })).toEqual({ ok: false, reason: 'already_sent' });
      expect((await getEmailState('entradas', o.id))?.status).toBe('sent');
    });

    it('solo los pedidos ONLINE se barren y se cuentan: la taquilla no envía email y las invitaciones tienen su propio envío', async () => {
      const taquilla = await mkOrder({ channel: 'TAQUILLA', touchedAgoMs: 30 * MIN });
      const invitacion = await mkOrder({ channel: 'INVITACION', touchedAgoMs: 30 * MIN });
      const online = await mkOrder({ touchedAgoMs: 30 * MIN });
      const listed = (await listUnsent('entradas', { limit: 1000 })).map((r) => r.id);
      expect(listed).toContain(online.id);
      expect(listed).not.toContain(taquilla.id);
      expect(listed).not.toContain(invitacion.id);
    });

    it('lastError de un fallo antiguo (texto libre de antes de esta función) se conserva y la concesión nunca se muestra como error', async () => {
      const legacy = await mkOrder({ attempts: 1, lastError: 'No hay SMTP configurado', touchedAgoMs: 10 * MIN });
      expect(await getEmailState('entradas', legacy.id)).toMatchObject({ status: 'retrying', lastError: 'No hay SMTP configurado' });
      await claimEmailSend('entradas', legacy.id, { mode: 'auto' });
      expect(await getEmailState('entradas', legacy.id)).toMatchObject({ status: 'sending', lastError: null });
    });
  });

  describe('tienda: marcadores en ProcessedWebhookEvent', () => {
    it('trackEmail es idempotente y crea solo `email:shop:<id>:due`; claim crea el intento; enviado crea `email:shop:<id>` y libera la concesión', async () => {
      const { id } = await mkShop();
      await trackEmail('tienda', id);
      await trackEmail('tienda', id);
      expect(await markers(id)).toEqual([`email:shop:${id}:due`]);

      await claimEmailSend('tienda', id, { mode: 'auto' });
      expect(await markers(id)).toEqual([`email:shop:${id}:due`, `email:shop:${id}:lease`, `email:shop:${id}:try:1`].sort());

      await recordEmailSent('tienda', id);
      await recordEmailSent('tienda', id); // idempotente
      expect(await markers(id)).toEqual([`email:shop:${id}`, `email:shop:${id}:due`, `email:shop:${id}:try:1`].sort());
    });

    it('un fallo libera la concesión y deja el intento anotado (`:try:n`); el texto del error NO se guarda (solo va al log)', async () => {
      const { id } = await mkShop();
      await claimEmailSend('tienda', id, { mode: 'auto' });
      await recordEmailFailure('tienda', id, 'boom con datos@personales.es');
      expect(await markers(id)).toEqual([`email:shop:${id}:due`, `email:shop:${id}:try:1`].sort());
      expect((await getEmailState('tienda', id))?.lastError).toBeNull();
    });

    it('un pedido SIN rastro (anterior a esta función) no se barre ni se cuenta, y su estado es `unknown` (la pantalla no promete nada)', async () => {
      const { id } = await mkShop();
      expect((await listUnsent('tienda', { limit: 1000 })).map((r) => r.id)).not.toContain(id);
      expect((await getEmailState('tienda', id))?.status).toBe('unknown');
    });

    it('un pedido de tienda reembolsado o cancelado tras pagar no se barre', async () => {
      const { id } = await mkShop();
      await trackEmail('tienda', id);
      await shopSetAge(id, 30 * MIN);
      expect((await listUnsent('tienda', { limit: 1000 })).map((r) => r.id)).toContain(id);
      await prisma.shopOrder.update({ where: { id }, data: { status: 'REFUNDED' } });
      expect((await listUnsent('tienda', { limit: 1000 })).map((r) => r.id)).not.toContain(id);
      await prisma.shopOrder.update({ where: { id }, data: { status: 'SHIPPED' } });
      expect((await listUnsent('tienda', { limit: 1000 })).map((r) => r.id)).toContain(id); // enviado/entregado siguen siendo pagados
    });

    it('LIMPIEZA NO DESTRUCTIVA: ninguna limpieza existente (sala de espera, caducidad del rate limiter) borra los marcadores', async () => {
      const { id } = await mkShop();
      await claimEmailSend('tienda', id, { mode: 'auto' });
      await recordEmailSent('tienda', id);
      await shopSetAge(id, 400 * 24 * 60 * MIN); // «de hace más de un año»
      const before = await markers(id);
      await cleanupAllStaleEntries();
      await prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date() } } }); // lo que hace la limpieza oportunista del limitador
      expect(await markers(id)).toEqual(before);
      expect(before.length).toBeGreaterThanOrEqual(3);
    });

    it('los prefijos no chocan con los demás marcadores de ProcessedWebhookEvent (evt_…, late-refund:…): leer los de un pedido no toca los ajenos', async () => {
      const { id } = await mkShop();
      await prisma.processedWebhookEvent.createMany({ data: [{ id: `late-refund:${id}` }, { id: `evt_email_${id}` }], skipDuplicates: true });
      await claimEmailSend('tienda', id, { mode: 'auto' });
      const st = await getEmailState('tienda', id);
      expect(st).toMatchObject({ status: 'sending', attempts: 1 });
      await prisma.processedWebhookEvent.deleteMany({ where: { id: { in: [`late-refund:${id}`, `evt_email_${id}`] } } });
    });
  });


  describe('M1: el barrido y los recuentos solo miran eventos vivos', () => {
    const HOUR = 60 * MIN;
    const evAt = async (status: 'DRAFT' | 'PUBLISHED' | 'FINISHED' | 'CANCELLED', dateOffsetMs: number) => {
      const e = await createTestEvent({ status, date: new Date(Date.now() + dateOffsetMs) });
      extraEvents.push(e.id);
      return e;
    };
    const extraEvents: string[] = [];
    afterAll(async () => {
      for (const id of extraEvents) await cleanupTestEvent(id);
    });

    it('listUnsent: ni cancelados ni borradores, ni eventos terminados hace más de 24 h; sí futuros, de hoy y terminados hace pocas horas', async () => {
      const cancelled = await mkOrder({ eventId: (await evAt('CANCELLED', 5 * 24 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const draft = await mkOrder({ eventId: (await evAt('DRAFT', 5 * 24 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const past3d = await mkOrder({ eventId: (await evAt('FINISHED', -3 * 24 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const past2h = await mkOrder({ eventId: (await evAt('PUBLISHED', -2 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const finished20h = await mkOrder({ eventId: (await evAt('FINISHED', -20 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const future = await mkOrder({ eventId: (await evAt('PUBLISHED', 5 * 24 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const listed = (await listUnsent('entradas', { limit: 1000 })).map((r) => r.id);
      for (const o of [past2h, finished20h, future]) expect(listed, o.id).toContain(o.id);
      for (const o of [cancelled, draft, past3d]) expect(listed, o.id).not.toContain(o.id);
    });

    it('el corte es el inicio del evento + el margen nocturno + 24 h (30 h): 29 h dentro, 31 h fuera', async () => {
      const inside = await mkOrder({ eventId: (await evAt('PUBLISHED', -29 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const outside = await mkOrder({ eventId: (await evAt('PUBLISHED', -31 * HOUR)).id, touchedAgoMs: 30 * MIN });
      const listed = (await listUnsent('entradas', { limit: 1000 })).map((r) => r.id);
      expect(listed).toContain(inside.id);
      expect(listed).not.toContain(outside.id);
    });

    it('countEmailBacklog aplica el MISMO filtro: los pedidos heredados de un evento cancelado o pasado no son «sin enviar» ni «fallidos»', async () => {
      const before = await countEmailBacklog('entradas');
      const cancelled = (await evAt('CANCELLED', 5 * 24 * HOUR)).id;
      const past = (await evAt('FINISHED', -3 * 24 * HOUR)).id;
      const live = (await evAt('PUBLISHED', 2 * 24 * HOUR)).id;
      for (const eventId of [cancelled, past]) {
        await mkOrder({ eventId, touchedAgoMs: 30 * MIN });
        await mkOrder({ eventId, attempts: EMAIL_MAX_ATTEMPTS, touchedAgoMs: 2 * HOUR });
      }
      const mid = await countEmailBacklog('entradas');
      expect(mid).toEqual(before);
      await mkOrder({ eventId: live, touchedAgoMs: 30 * MIN });
      await mkOrder({ eventId: live, attempts: EMAIL_MAX_ATTEMPTS, touchedAgoMs: 2 * HOUR });
      const after = await countEmailBacklog('entradas');
      expect(after.unsent - before.unsent).toBe(1);
      expect(after.failed - before.failed).toBe(1);
    });

    it('emailsFailed solo cuenta los agotados de las últimas 48 h (una errata no deja la ficha en rojo una semana); entradas y tienda', async () => {
      expect(EMAIL_FAILED_WINDOW_MS).toBe(48 * HOUR);
      for (const kind of ['entradas', 'tienda'] as const) {
        const before = await countEmailBacklog(kind);
        const make = async (agoMs: number) => {
          if (kind === 'entradas') return mkOrder({ attempts: EMAIL_MAX_ATTEMPTS, touchedAgoMs: agoMs });
          const o = await mkShop();
          await trackEmail('tienda', o.id);
          for (let i = 1; i <= EMAIL_MAX_ATTEMPTS; i++) await prisma.processedWebhookEvent.create({ data: { id: `email:shop:${o.id}:try:${i}` } });
          await shopSetAge(o.id, agoMs);
          return o;
        };
        await make(10 * HOUR);
        await make(60 * HOUR);
        await make(5 * 24 * HOUR);
        expect((await countEmailBacklog(kind)).failed - before.failed, kind).toBe(1);
      }
    });
  });

  describe('M2: clases de fallo (sistémico / permanente / normal)', () => {
    for (const { kind, make } of [
      { kind: 'entradas' as const, make: async (o: { attempts: number; touchedAgoMs: number }) => (await mkOrder(o)).id },
      {
        kind: 'tienda' as const,
        make: async (o: { attempts: number; touchedAgoMs: number }) => {
          const id = (await mkShop()).id;
          await trackEmail('tienda', id);
          for (let i = 1; i <= o.attempts; i++) await prisma.processedWebhookEvent.create({ data: { id: `email:shop:${id}:try:${i}` } });
          await shopSetAge(id, o.touchedAgoMs);
          return id;
        },
      },
    ]) {
      it(`${kind}: un fallo SISTÉMICO no agota el pedido: el sexto intento no cuenta, queda en 5 y se reintenta con el backoff de 180 min`, async () => {
        const id = await make({ attempts: EMAIL_MAX_ATTEMPTS - 1, touchedAgoMs: 200 * MIN });
        const claim = await claimEmailSend(kind, id, { mode: 'auto' });
        expect(claim).toMatchObject({ ok: true, attempt: EMAIL_MAX_ATTEMPTS });
        if (!claim.ok) return;
        const r = await recordEmailFailure(kind, id, 'smtp_unavailable: ETIMEDOUT', { klass: 'systemic', attempt: claim.attempt, lease: claim.lease });
        expect(r).toEqual({ attempts: EMAIL_MAX_ATTEMPTS - 1, exhausted: false });
        expect((await getEmailState(kind, id))?.status).toBe('retrying');
        // Sigue en el backoff más largo, medido desde ESTE intento: ni inmediato ni nunca.
        expect(await claimEmailSend(kind, id, { mode: 'auto' })).toEqual({ ok: false, reason: 'backoff' });
        const next = (await getEmailState(kind, id))?.nextAttemptAt?.getTime() ?? 0;
        expect(next - Date.now()).toBeGreaterThan(170 * MIN);
        expect(next - Date.now()).toBeLessThanOrEqual(180 * MIN);
      });

      it(`${kind}: un fallo SISTÉMICO repetido nunca agota (10 rondas), y al recuperarse se envía`, async () => {
        const id = await make({ attempts: EMAIL_MAX_ATTEMPTS - 1, touchedAgoMs: 200 * MIN });
        for (let round = 0; round < 10; round++) {
          const claim = await claimEmailSend(kind, id, { mode: 'auto' });
          expect(claim.ok, `ronda ${round}`).toBe(true);
          if (!claim.ok) return;
          const r = await recordEmailFailure(kind, id, 'config_unavailable', { klass: 'systemic', attempt: claim.attempt, lease: claim.lease });
          expect(r.exhausted).toBe(false);
          await (kind === 'entradas' ? setTouched(id, 200 * MIN) : shopSetAge(id, 200 * MIN));
        }
        expect((await getEmailState(kind, id))?.status).toBe('retrying');
        const claim = await claimEmailSend(kind, id, { mode: 'auto' });
        expect(claim.ok).toBe(true);
        await recordEmailSent(kind, id);
        expect((await getEmailState(kind, id))?.status).toBe('sent');
      });

      it(`${kind}: un fallo PERMANENTE (el destinatario rechaza) deja el pedido agotado al instante, sin gastar los 6 intentos`, async () => {
        const id = await make({ attempts: 0, touchedAgoMs: 30 * MIN });
        const claim = await claimEmailSend(kind, id, { mode: 'auto' });
        expect(claim.ok).toBe(true);
        if (!claim.ok) return;
        const r = await recordEmailFailure(kind, id, 'smtp_rejected: el servidor rechaza al destinatario', { klass: 'permanent', attempt: claim.attempt, lease: claim.lease });
        expect(r).toMatchObject({ exhausted: true });
        expect(r.attempts).toBeGreaterThanOrEqual(EMAIL_MAX_ATTEMPTS);
        expect((await getEmailState(kind, id))?.status).toBe('exhausted');
        expect((await listUnsent(kind, { limit: 1000 })).map((x) => x.id)).not.toContain(id);
      });

      it(`${kind}: un fallo NORMAL sigue consumiendo intentos (y el sistémico de los primeros intentos también cuenta hasta el 5.º)`, async () => {
        const id = await make({ attempts: 0, touchedAgoMs: 30 * MIN });
        const claim = await claimEmailSend(kind, id, { mode: 'auto' });
        if (!claim.ok) throw new Error('claim');
        const r = await recordEmailFailure(kind, id, 'smtp_unavailable: ETIMEDOUT', { klass: 'systemic', attempt: claim.attempt, lease: claim.lease });
        expect(r.attempts).toBe(1); // el backoff necesita saber cuántos van
      });
    }
  });

  describe('B2: una concesión caducada que falla no pisa la del nuevo dueño', () => {
    it('entradas: el fallo del dueño viejo (con su marca de concesión) no toca `sending:` del nuevo ni sus intentos', async () => {
      const o = await mkOrder();
      const old = await claimEmailSend('entradas', o.id, { mode: 'manual' });
      if (!old.ok) throw new Error('claim');
      await setTouched(o.id, EMAIL_LEASE_MS + 5_000); // caduca
      const fresh = await claimEmailSend('entradas', o.id, { mode: 'manual' });
      expect(fresh).toMatchObject({ ok: true, attempt: 2 });
      const before = await reloadOrder(o.id);
      await recordEmailFailure('entradas', o.id, 'smtp_unavailable: ETIMEDOUT', { klass: 'systemic', attempt: old.attempt, lease: old.lease });
      const after = await reloadOrder(o.id);
      expect(after?.emailLastError).toBe(before?.emailLastError);
      expect(after?.emailLastError).toMatch(/^sending:/);
      expect((await getEmailState('entradas', o.id))?.status).toBe('sending');
      // …y el dueño vigente SÍ puede anotar su fallo.
      if (!fresh.ok) return;
      await recordEmailFailure('entradas', o.id, 'smtp_failed: x', { attempt: fresh.attempt, lease: fresh.lease });
      expect((await reloadOrder(o.id))?.emailLastError).toBe('smtp_failed: x');
    });

    it('tienda: liberar con la marca de un dueño viejo no borra la concesión del nuevo', async () => {
      const { id } = await mkShop();
      const old = await claimEmailSend('tienda', id, { mode: 'manual' });
      if (!old.ok) throw new Error('claim');
      await shopSetAge(id, EMAIL_LEASE_MS + 5_000);
      const fresh = await claimEmailSend('tienda', id, { mode: 'manual' });
      expect(fresh.ok).toBe(true);
      await recordEmailFailure('tienda', id, 'x', { attempt: old.attempt, lease: old.lease });
      expect((await getEmailState('tienda', id))?.status).toBe('sending');
      expect(await claimEmailSend('tienda', id, { mode: 'manual' })).toEqual({ ok: false, reason: 'in_progress' });
    });
  });

  describe('M6: un pedido «pendiente» sin envío en curso deja de decir «enviándose»', () => {
    it('buyerEmailView: pending reciente → sending; pending de más de 3 min sin intentos → retrying; sending vivo → sending; el resto igual', () => {
      const now = Date.now();
      expect(EMAIL_PENDING_STALE_MS).toBe(3 * MIN);
      expect(buyerEmailView({ status: 'pending', touchedAt: new Date(now - 60_000) }, now)).toBe('sending');
      expect(buyerEmailView({ status: 'pending', touchedAt: new Date(now - 4 * MIN) }, now)).toBe('retrying');
      expect(buyerEmailView({ status: 'pending', touchedAt: null }, now)).toBe('sending');
      expect(buyerEmailView({ status: 'sending', touchedAt: new Date(now - 60 * MIN) }, now)).toBe('sending');
      expect(buyerEmailView({ status: 'retrying' }, now)).toBe('retrying');
      expect(buyerEmailView({ status: 'exhausted' }, now)).toBe('failed');
    });

    it('el estado real de un pedido pagado hace 10 min sin intentos lleva su `touchedAt` (entradas y tienda)', async () => {
      const o = await mkOrder({ touchedAgoMs: 10 * MIN });
      const st = await getEmailState('entradas', o.id);
      expect(st?.status).toBe('pending');
      expect(buyerEmailView(st)).toBe('retrying');
      const { id } = await mkShop();
      await trackEmail('tienda', id);
      await shopSetAge(id, 10 * MIN);
      expect(buyerEmailView(await getEmailState('tienda', id))).toBe('retrying');
    });
  });

  describe('piezas puras', () => {
    it('los parámetros pedidos: 6 intentos como máximo, concesión de 2 min, backoff 2/5/15/60/180 min y ventana de 7 días', () => {
      expect(EMAIL_MAX_ATTEMPTS).toBe(6);
      expect(EMAIL_LEASE_MS).toBe(2 * MIN);
      expect(EMAIL_BACKOFF_MS).toEqual([2, 5, 15, 60, 180].map((m) => m * MIN));
      expect(EMAIL_WINDOW_MS).toBe(7 * 24 * 60 * MIN);
    });

    it('backoffAfter: 2 min sin intentos y 2, 5, 15, 60, 180 tras cada fallo (el último se mantiene)', () => {
      expect([0, 1, 2, 3, 4, 5, 6, 9].map((a) => backoffAfter(a) / MIN)).toEqual([2, 2, 5, 15, 60, 180, 180, 180]);
    });

    it('deriveEmailState: enviado gana a todo; una concesión viva es `sending`; caducada vuelve a su estado', () => {
      const base = { kind: 'entradas' as const, id: 'x', lastError: null, lastAttemptAt: null, touchedAt: null, tracked: true, now: Date.now() };
      expect(deriveEmailState({ ...base, sentAt: new Date(), attempts: 9, leaseAt: new Date() }).status).toBe('sent');
      expect(deriveEmailState({ ...base, sentAt: null, attempts: 1, leaseAt: new Date() }).status).toBe('sending');
      expect(deriveEmailState({ ...base, sentAt: null, attempts: 1, leaseAt: ago(EMAIL_LEASE_MS + 1000) }).status).toBe('retrying');
      expect(deriveEmailState({ ...base, sentAt: null, attempts: 0, leaseAt: null }).status).toBe('pending');
    });

    it('deriveEmailState calcula cuándo toca el próximo reintento', () => {
      const last = ago(1 * MIN);
      const st = deriveEmailState({ kind: 'tienda', id: 'x', sentAt: null, attempts: 2, lastError: null, lastAttemptAt: last, leaseAt: null, touchedAt: last, tracked: true, now: Date.now() });
      expect(st.nextAttemptAt?.getTime()).toBe(last.getTime() + 5 * MIN);
    });

    it('sanitizeEmailError: sin direcciones de correo, una línea, corto, y nunca empieza por la marca de concesión', () => {
      expect(sanitizeEmailError('Rechazado: juan.perez@gmail.com no existe')).toBe('Rechazado: [email] no existe');
      expect(sanitizeEmailError('a\nb\n  c')).toBe('a b c');
      expect(sanitizeEmailError('x'.repeat(500))).toHaveLength(160);
      expect(sanitizeEmailError('sending:123')).toBe('error: sending:123');
      expect(sanitizeEmailError('')).toBe('Error desconocido al enviar');
      expect(sanitizeEmailError(undefined)).toBe('Error desconocido al enviar');
    });
  });
});
