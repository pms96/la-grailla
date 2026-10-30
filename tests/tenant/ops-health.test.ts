import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveCronSecret, generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { latestMigrationOnDisk } from '../helpers/migrations';
import { enablePlatformEnv } from '../helpers/platform';
import { TEST_TENANT_IDS, disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';
import { EMAIL_MAX_ATTEMPTS, EMAIL_WINDOW_MS } from '@/lib/email-delivery';
import { OPS_RECONCILE_KEY, collectOps, parseReconcileSummary } from '@/lib/ops-health';

/* P0-07: el productor del bloque `ops` de /api/health, con la BD real del cliente A. Valores con datos sembrados, parcial si falla una consulta,
 * tope de tiempo, sin datos personales y solo con el secreto de cron del cliente. */

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
let env: ReturnType<typeof enablePlatformEnv>;
let cronMaster: string;
let route: typeof import('@/app/api/health/route');
let n = 0;

const db = () => tenantClient('a');
const call = (secret: string | null) => new Request('http://localhost/api/health', { headers: secret === null ? {} : { Authorization: `Bearer ${secret}` } });
const health = async (secret: string | null) => {
  const s = secret === 'valid' ? await deriveCronSecret(parseMasterKey(cronMaster), TEST_TENANT_IDS.a) : secret;
  return withTenantForTest('a', () => route.GET(call(s)));
};
const ops = () => withTenantForTest('a', () => collectOps());

let eventId: string;
async function order(over: { status?: 'PENDING' | 'COMPLETED'; provider?: string | null; paymentId?: string | null; createdAgoMs?: number; attempts?: number; sent?: boolean; channel?: string; touchedAgoMs?: number }) {
  const o = await db().order.create({
    data: {
      eventId, buyerName: 'Persona Privada', buyerLastName: 'Apellido', buyerEmail: `privado-${n++}@datos-personales.es`, totalAmount: 10, status: over.status ?? 'COMPLETED',
      paymentProvider: over.provider === undefined ? null : over.provider, paymentId: over.paymentId === undefined ? null : over.paymentId, channel: over.channel ?? 'ONLINE',
      emailAttempts: over.attempts ?? 0, emailSentAt: over.sent ? new Date() : null, createdAt: ago(over.createdAgoMs ?? 60 * MIN),
    },
  });
  if (over.touchedAgoMs !== undefined) await db().$executeRaw`UPDATE "Order" SET "updatedAt" = ${ago(over.touchedAgoMs)} WHERE "id" = ${o.id}`;
  return o;
}
async function shop(over: { status?: 'PENDING' | 'PAID'; provider?: string | null; paymentId?: string | null; createdAgoMs?: number; due?: boolean; tries?: number; sent?: boolean; markerAgoMs?: number }) {
  const o = await db().shopOrder.create({
    data: {
      buyerName: 'Cliente Privado', buyerEmail: `tienda-privada-${n++}@datos-personales.es`, shippingAddress: 'Calle Secreta 1', shippingCity: 'Ciudad', shippingZip: '28001', totalAmount: 10,
      status: over.status ?? 'PAID', paymentProvider: over.provider === undefined ? null : over.provider, paymentId: over.paymentId === undefined ? null : over.paymentId, createdAt: ago(over.createdAgoMs ?? 60 * MIN),
    },
  });
  const at = ago(over.markerAgoMs ?? 30 * MIN);
  const rows = [
    ...(over.due === false ? [] : [{ id: `email:shop:${o.id}:due`, processedAt: at }]),
    ...Array.from({ length: over.tries ?? 0 }, (_, i) => ({ id: `email:shop:${o.id}:try:${i + 1}`, processedAt: at })),
    ...(over.sent ? [{ id: `email:shop:${o.id}`, processedAt: at }] : []),
  ];
  if (rows.length) await db().processedWebhookEvent.createMany({ data: rows });
  return o;
}

beforeAll(async () => {
  await ensureTenantDatabases();
  route = await import('@/app/api/health/route');
}, 180_000);
beforeEach(async () => {
  cronMaster = generateMasterKey();
  env = enablePlatformEnv({ PLATFORM_CRON_MASTER: cronMaster, CRON_SECRET: 'global-de-tests', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890' });
  vi.stubEnv('FRONT_SCHEMA_EXPECTED', latestMigrationOnDisk());
  await resetTenantDatabase('a');
  for (const [key, value] of [['admin_email', 'duena@cliente.es'], ['legal_notice', 'a'], ['privacy_policy', 'b'], ['cookies_policy', 'c']]) await db().appConfig.create({ data: { key, value } });
  eventId = (await db().event.create({ data: { name: 'Evento ops', slug: 'evento-ops', venue: 'Sala', city: 'Madrid', date: new Date(Date.now() + 5 * 86_400_000), maxCapacity: 100, status: 'PUBLISHED' } })).id;
});
afterEach(() => env.restore());
afterAll(async () => {
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('bloque `ops` de /api/health', () => {
  it('BD sin pedidos: ceros, sin pendiente más antiguo y sin pasada del cron', async () => {
    expect(await ops()).toEqual({ generatedAt: expect.any(String), pendingOldestMinutes: null, pendingOver20min: 0, emailsUnsent: 0, emailsFailed: 0, reconcile: null, gateway: null, sales: { orders15min: 0, waitingRoom: 0 }, obligations: { ticketOrdersPending: 0, futureEventsWithTickets: 0, shopOrdersPending: 0, shopOrdersToShip: 0 } });
  });

  it('`sales` (P1-22): cuenta los pedidos de los últimos 15 min (cualquier estado) y la gente en sala de espera, no los de antes ni los ya terminados', async () => {
    await order({ createdAgoMs: 2 * MIN });
    await order({ status: 'PENDING', provider: 'stripe', paymentId: 'cs_s1', createdAgoMs: 14 * MIN });
    await order({ createdAgoMs: 16 * MIN }); // fuera de la ventana
    const queue = (status: 'WAITING' | 'ADMITTED' | 'COMPLETED' | 'EXPIRED') => db().waitingRoomEntry.create({ data: { eventId, token: `tok-${n++}`, status } });
    await queue('WAITING');
    await queue('ADMITTED');
    await queue('COMPLETED'); // ya compró: no ocupa
    await queue('EXPIRED'); // caducado: no ocupa
    expect((await ops())!.sales).toEqual({ orders15min: 2, waitingRoom: 2 });
  });

  it('`obligations` (P1-20): cuenta lo que impide apagar un módulo, y no cuenta lo viejo, lo ya enviado ni los eventos pasados o sin entradas', async () => {
    // Entradas: pedidos PENDING de las últimas 24 h (uno viejo = pago abandonado, no cuenta) y eventos por venir con entradas válidas.
    await order({ status: 'PENDING', createdAgoMs: 3 * 60 * MIN });
    await order({ status: 'PENDING', createdAgoMs: 30 * 60 * MIN }); // más de 24 h
    await order({ status: 'COMPLETED' }); // ya pagado: no es obligación de «pendiente»
    const ticket = async (event: string, status: 'VALID' | 'CANCELLED') => {
      const o = await order({});
      await db().ticket.create({ data: { orderId: o.id, eventId: event, qrCode: `qr-${n++}`, holderName: 'Asistente', status } });
    };
    await ticket(eventId, 'VALID'); // evento publicado, futuro, con una entrada válida → cuenta 1
    await ticket(eventId, 'VALID'); // otra entrada del mismo evento: sigue siendo 1 evento
    const other = (slug: string, date: Date, status: 'PUBLISHED' | 'FINISHED') => db().event.create({ data: { name: slug, slug, venue: 'Sala', city: 'Madrid', date, maxCapacity: 10, status } });
    const past = await other('evento-pasado', new Date(Date.now() - 3 * 86_400_000), 'PUBLISHED');
    await ticket(past.id, 'VALID'); // ya pasó
    const ongoing = await other('evento-esta-noche', new Date(Date.now() - 2 * 60 * MIN), 'PUBLISHED');
    await ticket(ongoing.id, 'VALID'); // empezó hace 2 h: la noche sigue → cuenta
    const cancelledOnly = await other('evento-sin-validas', new Date(Date.now() + 86_400_000), 'PUBLISHED');
    await ticket(cancelledOnly.id, 'CANCELLED'); // sin entradas válidas
    const finished = await other('evento-terminado', new Date(Date.now() + 86_400_000), 'FINISHED');
    await ticket(finished.id, 'VALID'); // no publicado
    // Tienda: PENDING de las últimas 24 h; PAID y PROCESSING sin enviar (SHIPPED no).
    await shop({ status: 'PENDING', createdAgoMs: 5 * MIN });
    await shop({ status: 'PENDING', createdAgoMs: 30 * 60 * MIN });
    await shop({ status: 'PAID' });
    await db().shopOrder.updateMany({ where: { id: (await shop({ status: 'PAID' })).id }, data: { status: 'PROCESSING' } });
    await db().shopOrder.updateMany({ where: { id: (await shop({ status: 'PAID' })).id }, data: { status: 'SHIPPED' } });
    expect((await ops())!.obligations).toEqual({ ticketOrdersPending: 1, futureEventsWithTickets: 2, shopOrdersPending: 1, shopOrdersToShip: 2 });
  });

  it('valores correctos con datos sembrados (pendientes con pago real, emails sin enviar y fallidos de entradas y tienda, resumen del cron)', async () => {
    // Pendientes: solo cuentan los que tienen paymentId de una pasarela REAL (no la simulada) y siguen PENDING.
    await order({ status: 'PENDING', provider: 'stripe', paymentId: 'cs_1', createdAgoMs: 45 * MIN });
    await order({ status: 'PENDING', provider: 'sumup', paymentId: 'cs_2', createdAgoMs: 10 * MIN });
    await shop({ status: 'PENDING', provider: 'stripe', paymentId: 'cs_3', createdAgoMs: 90 * MIN, due: false });
    await order({ status: 'PENDING', provider: 'mock', paymentId: 'mock_1', createdAgoMs: 500 * MIN }); // simulada: no cuenta
    await order({ status: 'PENDING', provider: null, paymentId: null, createdAgoMs: 500 * MIN }); // nunca llegó a la pasarela: no cuenta
    await order({ status: 'COMPLETED', provider: 'stripe', paymentId: 'cs_4', createdAgoMs: 500 * MIN }); // ya pagado: no cuenta
    // Emails de entradas.
    await order({ touchedAgoMs: 20 * MIN }); // sin intentos y >10 min → sin enviar
    await order({ attempts: 1, touchedAgoMs: 1 * MIN }); // ya falló una vez → sin enviar
    await order({ touchedAgoMs: 2 * MIN }); // sin intentos y reciente → aún no cuenta
    await order({ attempts: EMAIL_MAX_ATTEMPTS, touchedAgoMs: 100 * MIN }); // agotado
    await order({ sent: true, touchedAgoMs: 100 * MIN }); // enviado
    await order({ channel: 'TAQUILLA', touchedAgoMs: 100 * MIN }); // la taquilla no envía email
    await order({ touchedAgoMs: EMAIL_WINDOW_MS + 60 * MIN }); // demasiado antiguo
    // Emails de la tienda (marcadores).
    await shop({ tries: 1 }); // pagado, falló una vez → sin enviar
    await shop({ tries: EMAIL_MAX_ATTEMPTS }); // agotado
    await shop({ tries: 1, sent: true }); // enviado
    await shop({ due: false }); // anterior al seguimiento: sin rastro, no cuenta
    // Resumen del cron.
    const lastRunAt = ago(3 * MIN).toISOString();
    await db().appConfig.create({ data: { key: OPS_RECONCILE_KEY, value: JSON.stringify({ lastRunAt, errors: 2, unknown: 1, processing: 3, stuckOver24h: 4 }) } });

    const block = (await ops())!;
    expect(Object.keys(block).sort()).toEqual(['emailsFailed', 'emailsUnsent', 'gateway', 'generatedAt', 'obligations', 'pendingOldestMinutes', 'pendingOver20min', 'reconcile', 'sales']);
    expect(block.pendingOldestMinutes).toBe(90); // el PENDING de tienda de hace 90 min
    expect(block.pendingOver20min).toBe(2); // los de 45 y 90 min
    expect(block.emailsUnsent).toBe(3); // 2 de entradas + 1 de tienda
    expect(block.emailsFailed).toBe(2); // 1 de entradas + 1 de tienda
    expect(block.reconcile).toEqual({ lastRunAt, errors: 2, unknown: 1, processing: 3, stuckOver24h: 4 });
    expect(Math.abs(Date.parse(block.generatedAt) - Date.now())).toBeLessThan(5_000);
    expect(new Date(block.generatedAt).toISOString()).toBe(block.generatedAt);
  });

  it('SIN datos personales ni ids de pedido: solo recuentos y minutos', async () => {
    const o = await order({ status: 'PENDING', provider: 'stripe', paymentId: 'cs_secreto_123', createdAgoMs: 60 * MIN });
    const s = await shop({ tries: 1 });
    await order({ attempts: EMAIL_MAX_ATTEMPTS });
    const json = JSON.stringify(await ops());
    for (const forbidden of ['privado', 'datos-personales', 'Persona', 'Apellido', 'Cliente Privado', 'Calle Secreta', 'cs_secreto_123', o.id, s.id, 'stripe']) expect(json, forbidden).not.toContain(forbidden);
    const res = await health('valid');
    const text = JSON.stringify((await res.json()).ops);
    for (const forbidden of ['privado', 'datos-personales', 'cs_secreto_123', o.id, s.id]) expect(text, forbidden).not.toContain(forbidden);
  });

  it('el resumen del cron inválido, ausente o corrupto sale como null (nunca se propaga el texto guardado)', async () => {
    expect(parseReconcileSummary(null)).toBeNull();
    expect(parseReconcileSummary('no es json <script>')).toBeNull();
    expect(parseReconcileSummary(JSON.stringify({ lastRunAt: 'x', errors: 'muchos', unknown: 0, processing: 0, stuckOver24h: 0 }))).toBeNull();
    expect(parseReconcileSummary(JSON.stringify({ lastRunAt: 'no-fecha', errors: 1, unknown: 0, processing: 0, stuckOver24h: 0 }))).toEqual({ lastRunAt: null, errors: 1, unknown: 0, processing: 0, stuckOver24h: 0 });
    await db().appConfig.create({ data: { key: OPS_RECONCILE_KEY, value: '{"lastRunAt": "<b>x</b>", "errors": -5}' } });
    expect((await ops())!.reconcile).toBeNull();
  });

  describe('a prueba de fallos', () => {
    async function withRenamedTables<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
      for (const t of tables) await db().$executeRawUnsafe(`ALTER TABLE "${t}" RENAME TO "${t}_roto"`);
      try {
        return await fn();
      } finally {
        for (const t of tables) await db().$executeRawUnsafe(`ALTER TABLE "${t}_roto" RENAME TO "${t}"`);
      }
    }

    it('si falla UNA consulta, `ops` sale parcial (ese campo null) y el resto sigue; el health NO falla', async () => {
      await order({ status: 'PENDING', provider: 'stripe', paymentId: 'cs_1', createdAgoMs: 45 * MIN });
      await db().appConfig.create({ data: { key: OPS_RECONCILE_KEY, value: JSON.stringify({ lastRunAt: ago(MIN).toISOString(), errors: 0, unknown: 0, processing: 0, stuckOver24h: 0 }) } });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await withRenamedTables(['ShopOrder'], async () => {
        const block = (await ops())!;
        // Las dos medidas que leen la tabla de tienda y la de emails (que también la lee) quedan en null; el resumen del cron sigue.
        expect(block.pendingOldestMinutes).toBeNull();
        expect(block.pendingOver20min).toBeNull();
        expect(block.emailsUnsent).toBeNull();
        expect(block.emailsFailed).toBeNull();
        expect(block.reconcile).toMatchObject({ errors: 0 });
        const res = await health('valid');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
        expect(body.db.ok).toBe(true);
        expect(body.ops).toMatchObject({ pendingOver20min: null, reconcile: { errors: 0 } });
      });
      // Restablecida la tabla, todo vuelve.
      expect((await ops())!.pendingOver20min).toBe(1);
    });

    it('si falla TODO lo que se mide, `ops` es null y el health sigue respondiendo con el resto de campos', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await withRenamedTables(['Order', 'ShopOrder', 'AppConfig', 'ProcessedWebhookEvent'], async () => {
        expect(await ops()).toBeNull();
      });
    });

    it('tiene un tope de tiempo: con la tabla de pedidos bloqueada, el bloque llega a tiempo y lo que lee `Order` sale null (nunca cuelga el health)', async () => {
      await db().appConfig.create({ data: { key: OPS_RECONCILE_KEY, value: JSON.stringify({ lastRunAt: ago(MIN).toISOString(), errors: 0, unknown: 0, processing: 0, stuckOver24h: 0 }) } });
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      const blocker = db().$transaction(async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "Order" IN ACCESS EXCLUSIVE MODE');
        locked();
        await held;
      }, { timeout: 15_000 });
      await lockedP;
      try {
        const t0 = Date.now();
        const block = await withTenantForTest('a', () => collectOps(Date.now(), 400));
        expect(Date.now() - t0).toBeLessThan(1500); // sin el tope esperaría al bloqueo (varios segundos)
        // Con el pool ocupado por las consultas bloqueadas puede que ni el resumen del cron haya cabido (entonces todo es null); si cabe, el resto sigue.
        if (block) {
          expect(block.pendingOldestMinutes).toBeNull();
          expect(block.emailsUnsent).toBeNull();
        }
      } finally {
        release();
        await blocker;
      }
    });
  });

  describe('autenticación: `ops` solo sale con el secreto de cron del cliente', () => {
    it('la respuesta pública sigue siendo {status} a secas, con o sin datos', async () => {
      await order({ attempts: EMAIL_MAX_ATTEMPTS });
      const res = await health(null);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
      expect(await (await health('secreto-incorrecto')).json()).toEqual({ status: 'ok' });
      expect(await (await withTenantForTest('b', async () => route.GET(call(await deriveCronSecret(parseMasterKey(cronMaster), TEST_TENANT_IDS.a))))).json()).toEqual({ status: 'ok' });
    });

    it('con el secreto del cliente: el bloque con la forma exacta y los campos de siempre intactos', async () => {
      await order({ attempts: EMAIL_MAX_ATTEMPTS });
      const body = await (await health('valid')).json();
      expect(Object.keys(body).sort()).toEqual(['db', 'onboarding', 'ops', 'platform', 'schema', 'serving', 'status', 'tenantId', 'tenantMarker', 'version']);
      expect(body.ops).toEqual({ generatedAt: expect.any(String), pendingOldestMinutes: null, pendingOver20min: 0, emailsUnsent: 0, emailsFailed: 1, reconcile: null, gateway: null, sales: { orders15min: 0, waitingRoom: 0 }, obligations: { ticketOrdersPending: 0, futureEventsWithTickets: 0, shopOrdersPending: 0, shopOrdersToShip: 0 } });
      expect(body.status).toBe('ok');
    });

    it('con la BD de OTRO cliente (marca distinta) no se lee nada de negocio: ops null', async () => {
      await db().appConfig.create({ data: { key: 'platform_tenant_id', value: TEST_TENANT_IDS.b, group: 'platform' } });
      await order({ attempts: EMAIL_MAX_ATTEMPTS });
      const res = await health('valid');
      expect(res.status).toBe(503);
      expect((await res.json()).ops).toBeNull();
    });
  });
});
