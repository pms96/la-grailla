import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { EVENT_GRACE_PERIOD_MS } from '@/lib/active-event';

/* Estado de entrega del email de un pedido (P0-08): UNA interfaz, dos implementaciones. Los llamadores (lib/order-email.ts, el barrido del
 * cron, las API de pantalla y de admin, el bloque `ops` de /api/health) solo conocen estas funciones; cuando la tienda tenga columnas
 * reales (migración aditiva), se cambia la implementación de `tienda` sin tocar a ninguno.
 *
 *   getEmailState(kind, id) · getEmailStates(kind, ids) · claimEmailSend(kind, id, opts) · recordEmailSent · recordEmailFailure
 *   listUnsent(kind, opts) · countEmailBacklog(kind, opts) · trackEmail(kind, id)
 *
 * ── ENTRADAS: columnas de `Order` que ya existen (`emailSentAt`, `emailAttempts`, `emailLastError`) ───────────────────────────────────────
 *   · Enviado:   `emailSentAt` no nulo.
 *   · Intentos:  `emailAttempts` (se incrementa al RECLAMAR el envío, no al terminar: una función cortada a mitad también cuenta y los
 *     reintentos no son infinitos). Tope EMAIL_MAX_ATTEMPTS; agotado = no enviado con `emailAttempts >= 6`.
 *   · Fallo:     `emailLastError` con un texto corto, sin datos personales ni credenciales.
 *   · CONCESIÓN (lease): mientras alguien envía, `emailLastError = 'sending:<epoch ms>'`. Se concede con un `updateMany` condicionado a
 *     lo que se LEYÓ (`emailLastError` y `emailAttempts` iguales, `emailSentAt` nulo): compare-and-swap atómico a nivel de fila, así que
 *     de N disparadores simultáneos solo uno gana y el resto recibe `in_progress`. Una concesión caduca a los EMAIL_LEASE_MS (2 min): si
 *     la función murió enviando, el siguiente disparador la releva (el CAS espera exactamente ese valor caducado). Un envío que termina
 *     escribe `emailSentAt` y limpia la marca, o deja el texto del fallo (que nunca empieza por `sending:`).
 *   · Hora del último intento: `updatedAt` (Prisma lo actualiza en cada escritura; tras pagar el pedido solo lo tocan estos intentos).
 *
 * ── TIENDA: `ShopOrder` no tiene campos de email y añadirlos exige una migración. Filas marcadoras en `ProcessedWebhookEvent` ───────────
 *   · `email:shop:<pedido>:due`      el pedido se pagó y se le debe un email (la hora es la del pago; sin esta fila no se barre: los
 *                                    pedidos anteriores a esta función no se reenvían, así que no hay duplicados retroactivos).
 *   · `email:shop:<pedido>:try:<n>`  intento n (empezado). Su número es el contador de intentos y su hora, la del último intento.
 *   · `email:shop:<pedido>:lease`    concesión: se crea con `createMany skipDuplicates` (la clave única es el cerrojo: un solo ganador);
 *                                    caduca a los EMAIL_LEASE_MS (quien la relevó la borra caducada y la vuelve a crear) y se borra al terminar.
 *   · `email:shop:<pedido>`          enviado.
 *   Nada borra estas filas (ningún cron de retención toca `ProcessedWebhookEvent`; el patrón ya lo usa `late-refund:<id>`) y ningún
 *   prefijo choca con los `evt_…` / `sumup:…` / `late-refund:…`. No guardan texto del error: la tienda solo expone el nº de intentos
 *   (el error va al log). */

export type EmailKind = 'entradas' | 'tienda';

/** Cuánto dura una concesión de envío antes de poder relevarla (una función cortada a mitad no la libera). */
export const EMAIL_LEASE_MS = 2 * 60_000;
/** Intentos máximos (el primero y los reintentos). Agotados = «fallido definitivo». */
export const EMAIL_MAX_ATTEMPTS = 6;
/** Espera mínima tras el intento n (1…5) antes del siguiente reintento AUTOMÁTICO: 2, 5, 15, 60 y 180 minutos. */
export const EMAIL_BACKOFF_MS: readonly number[] = [2, 5, 15, 60, 180].map((m) => m * 60_000);
/** Un pedido pagado que nadie ha intentado enviar no se barre hasta pasado este tiempo (el envío normal ya está en marcha). */
export const EMAIL_FIRST_SWEEP_AFTER_MS = 2 * 60_000;
/** Solo se barren/cuentan los pedidos de los últimos días: no se resucita lo antiguo. */
export const EMAIL_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Un pedido pagado sin email y sin ningún intento no cuenta como «sin enviar» (SLI) hasta pasado este tiempo. */
export const EMAIL_UNSENT_AFTER_MS = 10 * 60_000;
/** Los pedidos con los intentos agotados solo cuentan como fallo (bloque `ops`) durante este tiempo desde su último intento: una errata de email no deja la ficha en rojo una semana. */
export const EMAIL_FAILED_WINDOW_MS = 48 * 60 * 60_000;
/** Un pedido pagado SIN ningún intento ni envío en curso pasado este tiempo deja de mostrarse como «enviándose» al comprador (el barrido lo recogerá). */
export const EMAIL_PENDING_STALE_MS = 3 * 60_000;
/**
 * El barrido solo reenvía «Tus entradas» de eventos vivos: PUBLICADOS (o ya FINALIZADOS) y que no hayan terminado hace más de 24 h. Un evento termina
 * a su hora de inicio más el margen nocturno (`EVENT_GRACE_PERIOD_MS`, el mismo que usa la web para dejar de venderlo). Los CANCELADOS y los
 * BORRADORES nunca. Mismo filtro en el listado, el recuento «sin enviar» y el de «fallidos»: un pedido heredado de un evento ya pasado no es una señal.
 */
export const EMAIL_EVENT_MAX_AGE_MS = 24 * 60 * 60_000;
export const EMAIL_EVENT_STATUSES = ['PUBLISHED', 'FINISHED'] as const;
const liveEventWhere = (now: number) => ({
  status: { in: [...EMAIL_EVENT_STATUSES] },
  date: { gte: new Date(now - EVENT_GRACE_PERIOD_MS - EMAIL_EVENT_MAX_AGE_MS) },
});

/** Estados de la tienda en los que el pedido está pagado (y, por tanto, se le debe su email). */
export const SHOP_PAID_STATUSES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;

export type EmailStatus = 'sent' | 'sending' | 'pending' | 'retrying' | 'exhausted' | 'unknown';

export interface EmailState {
  kind: EmailKind;
  id: string;
  /** sent = confirmado · sending = hay un envío en curso · pending = nadie lo ha intentado aún · retrying = ha fallado y habrá reintento · exhausted = no habrá más intentos automáticos (agotados, o pedido demasiado antiguo para barrerlo) · unknown = sin rastro (tienda, pedido anterior al seguimiento). */
  status: EmailStatus;
  sentAt: Date | null;
  attempts: number;
  /** Texto corto del último fallo, sin datos personales. Siempre null en la tienda (no se guarda). */
  lastError: string | null;
  lastAttemptAt: Date | null;
  /** Cuándo toca el próximo reintento automático; null si ya está enviado, en curso o agotado. */
  nextAttemptAt: Date | null;
  /** Último movimiento del pedido (en entradas, el pago o el último intento; en tienda, el último intento o el pago). */
  touchedAt: Date | null;
}

export type ClaimSkipReason = 'not_found' | 'not_sendable' | 'already_sent' | 'in_progress' | 'backoff' | 'exhausted';
/** `lease`: la marca de esta concesión (la hora del reclamo). Quien la tiene la devuelve al anotar el fallo: una concesión caducada y relevada por otro NO pisa la del nuevo dueño. */
export type ClaimResult = { ok: true; attempt: number; lease: number } | { ok: false; reason: ClaimSkipReason };

/**
 * Qué clase de fallo fue, para decidir cuánto cuesta el intento:
 *  - `normal`: del pedido o desconocido: consume el presupuesto de intentos.
 *  - `systemic`: del servidor de correo (sin SMTP configurado, conexión, tiempo, credenciales, BD): afecta a TODOS los pedidos por igual y se arregla en la
 *    configuración. NO agota el pedido: el contador no pasa del 5.º intento, así que se sigue reintentando con el backoff acotado (180 min) hasta que funcione.
 *  - `permanent`: el destinatario rechaza el correo (buzón inexistente, errata): no tiene sentido insistir, el pedido queda agotado enseguida.
 */
export type EmailFailureClass = 'normal' | 'systemic' | 'permanent';

export interface ClaimOptions {
  /** auto: disparadores y barrido (respetan el backoff y el máximo de intentos). manual: admin o comprador (los saltan, pero NUNCA la concesión). */
  mode: 'auto' | 'manual';
  /** Permite volver a enviar un email ya confirmado (reenvío a petición). */
  resend?: boolean;
  now?: number;
}

/** Tiempo de espera antes del próximo intento automático, dado cuántos lleva. */
export function backoffAfter(attempts: number): number {
  if (attempts <= 0) return EMAIL_FIRST_SWEEP_AFTER_MS;
  return EMAIL_BACKOFF_MS[Math.min(attempts, EMAIL_BACKOFF_MS.length) - 1];
}

/** Función pura: el estado a partir de lo que se lee de la BD. */
export function deriveEmailState(input: {
  kind: EmailKind;
  id: string;
  sentAt: Date | null;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  leaseAt: Date | null;
  /** Último movimiento del pedido (para saber si ya es demasiado antiguo para barrerlo). */
  touchedAt: Date | null;
  /** false = no hay rastro de seguimiento (pedido de tienda anterior a esta función). */
  tracked: boolean;
  now: number;
}): EmailState {
  const { sentAt, attempts, lastAttemptAt, leaseAt, now } = input;
  let status: EmailStatus;
  let nextAttemptAt: Date | null = null;
  if (sentAt) status = 'sent';
  else if (!input.tracked) status = 'unknown';
  else if (leaseAt && now - leaseAt.getTime() < EMAIL_LEASE_MS) status = 'sending';
  else if (attempts >= EMAIL_MAX_ATTEMPTS || (input.touchedAt && now - input.touchedAt.getTime() > EMAIL_WINDOW_MS)) status = 'exhausted';
  else if (attempts === 0) status = 'pending';
  else {
    status = 'retrying';
    if (lastAttemptAt) nextAttemptAt = new Date(lastAttemptAt.getTime() + backoffAfter(attempts));
  }
  return { kind: input.kind, id: input.id, status, sentAt, attempts, lastError: input.lastError, lastAttemptAt, nextAttemptAt, touchedAt: input.touchedAt };
}

/** Texto de error apto para guardar: corto, una sola línea, sin direcciones de correo y sin parecerse a una concesión. */
export function sanitizeEmailError(message: string | null | undefined): string {
  const text = String(message ?? '')
    .replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  if (!text) return 'Error desconocido al enviar';
  return /^sending:/i.test(text) ? `error: ${text}` : text;
}

const LEASE_RE = /^sending:(\d+)$/;
function parseLease(value: string | null): Date | null {
  const m = value ? LEASE_RE.exec(value) : null;
  return m ? new Date(Number(m[1])) : null;
}

// ── ENTRADAS (columnas de Order) ──────────────────────────────────────────────────────────────────────────────────────────────────────

const orderSelect = { id: true, status: true, emailSentAt: true, emailAttempts: true, emailLastError: true, updatedAt: true } as const;
type OrderEmailRow = { id: string; status: string; emailSentAt: Date | null; emailAttempts: number; emailLastError: string | null; updatedAt: Date };

function orderState(row: OrderEmailRow, now: number): EmailState {
  const lease = parseLease(row.emailLastError);
  return deriveEmailState({
    kind: 'entradas',
    id: row.id,
    sentAt: row.emailSentAt,
    attempts: row.emailAttempts,
    lastError: lease ? null : row.emailLastError,
    lastAttemptAt: row.emailAttempts > 0 ? row.updatedAt : null,
    leaseAt: lease,
    touchedAt: row.updatedAt,
    tracked: true,
    now,
  });
}

async function claimOrder(id: string, opts: ClaimOptions): Promise<ClaimResult> {
  const now = opts.now ?? Date.now();
  const row = await prisma.order.findUnique({ where: { id }, select: orderSelect });
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'COMPLETED') return { ok: false, reason: 'not_sendable' };
  if (row.emailSentAt && !opts.resend) return { ok: false, reason: 'already_sent' };
  const state = orderState(row, now);
  if (state.status === 'sending') return { ok: false, reason: 'in_progress' };
  if (opts.mode === 'auto' && !row.emailSentAt) {
    if (row.emailAttempts >= EMAIL_MAX_ATTEMPTS) return { ok: false, reason: 'exhausted' };
    // Sin intentos previos se envía ya (es el disparador del propio pago); la espera de 2 min solo la aplica el barrido.
    if (row.emailAttempts > 0 && now - row.updatedAt.getTime() < backoffAfter(row.emailAttempts)) return { ok: false, reason: 'backoff' };
  }
  // Compare-and-swap: solo gana quien encuentra la fila EXACTAMENTE como la leyó (mismo texto de error —o concesión caducada—, mismos intentos).
  const { count } = await prisma.order.updateMany({
    where: {
      id,
      status: 'COMPLETED',
      emailLastError: row.emailLastError,
      emailAttempts: row.emailAttempts,
      ...(opts.resend ? {} : { emailSentAt: null }),
    },
    data: { emailLastError: `sending:${now}`, emailAttempts: { increment: 1 } },
  });
  return count > 0 ? { ok: true, attempt: row.emailAttempts + 1, lease: now } : { ok: false, reason: 'in_progress' };
}

// ── TIENDA (marcadores en ProcessedWebhookEvent) ──────────────────────────────────────────────────────────────────────────────────────

const shopKey = {
  sent: (id: string) => `email:shop:${id}`,
  due: (id: string) => `email:shop:${id}:due`,
  lease: (id: string) => `email:shop:${id}:lease`,
  attempt: (id: string, n: number) => `email:shop:${id}:try:${n}`,
};

interface ShopMarkers {
  sentAt: Date | null;
  dueAt: Date | null;
  leaseAt: Date | null;
  tries: number;
  lastTryAt: Date | null;
}

const emptyMarkers = (): ShopMarkers => ({ sentAt: null, dueAt: null, leaseAt: null, tries: 0, lastTryAt: null });

/** Lee los marcadores de varios pedidos de una vez (una consulta). */
async function readShopMarkers(ids: string[]): Promise<Map<string, ShopMarkers>> {
  const out = new Map<string, ShopMarkers>(ids.map((id) => [id, emptyMarkers()]));
  if (ids.length === 0) return out;
  const rows = await prisma.$queryRaw<{ id: string; processedAt: Date }[]>(Prisma.sql`
    SELECT "id", "processedAt" FROM "ProcessedWebhookEvent"
    WHERE "id" LIKE 'email:shop:%' AND split_part("id", ':', 3) = ANY(${ids}::text[])`);
  for (const row of rows) {
    const [, , orderId, kind, n] = row.id.split(':');
    const m = out.get(orderId);
    if (!m) continue;
    if (!kind) m.sentAt = row.processedAt;
    else if (kind === 'due') m.dueAt = row.processedAt;
    else if (kind === 'lease') m.leaseAt = row.processedAt;
    else if (kind === 'try' && n) {
      m.tries += 1;
      if (!m.lastTryAt || row.processedAt > m.lastTryAt) m.lastTryAt = row.processedAt;
    }
  }
  return out;
}

function shopState(id: string, m: ShopMarkers, now: number): EmailState {
  return deriveEmailState({
    kind: 'tienda',
    id,
    sentAt: m.sentAt,
    attempts: m.tries,
    lastError: null,
    lastAttemptAt: m.lastTryAt ?? m.dueAt,
    leaseAt: m.leaseAt,
    touchedAt: m.lastTryAt ?? m.dueAt,
    tracked: m.dueAt !== null || m.tries > 0,
    now,
  });
}

/** Libera la concesión de la tienda. Con `lease` solo borra la de ESE reclamo: una caducada y relevada por otro no se lleva la del nuevo dueño. */
async function releaseShopLease(id: string, lease?: number): Promise<void> {
  await prisma.processedWebhookEvent.deleteMany({ where: { id: shopKey.lease(id), ...(lease !== undefined ? { processedAt: new Date(lease) } : {}) } });
}

async function claimShop(id: string, opts: ClaimOptions): Promise<ClaimResult> {
  const now = opts.now ?? Date.now();
  const order = await prisma.shopOrder.findUnique({ where: { id }, select: { status: true } });
  if (!order) return { ok: false, reason: 'not_found' };
  if (!(SHOP_PAID_STATUSES as readonly string[]).includes(order.status)) return { ok: false, reason: 'not_sendable' };
  const first = (await readShopMarkers([id])).get(id)!;
  if (first.sentAt && !opts.resend) return { ok: false, reason: 'already_sent' };

  // Concesión: relevar una caducada (borrarla) y crearla; la clave única deja pasar a UNO solo.
  await prisma.processedWebhookEvent.deleteMany({ where: { id: shopKey.lease(id), processedAt: { lt: new Date(now - EMAIL_LEASE_MS) } } });
  const { count } = await prisma.processedWebhookEvent.createMany({ data: [{ id: shopKey.lease(id), processedAt: new Date(now) }], skipDuplicates: true });
  if (count === 0) return { ok: false, reason: 'in_progress' };

  try {
    // Con la concesión ya en mano se vuelve a mirar: quien la tuvo antes pudo terminar (enviado) o fallar (backoff) entre la primera lectura y ahora.
    const m = (await readShopMarkers([id])).get(id)!;
    let reason: ClaimSkipReason | null = null;
    if (m.sentAt && !opts.resend) reason = 'already_sent';
    else if (opts.mode === 'auto' && !m.sentAt) {
      if (m.tries >= EMAIL_MAX_ATTEMPTS) reason = 'exhausted';
      else if (m.tries > 0 && m.lastTryAt && now - m.lastTryAt.getTime() < backoffAfter(m.tries)) reason = 'backoff';
    }
    if (reason) {
      await releaseShopLease(id);
      return { ok: false, reason };
    }
    const attempt = m.tries + 1;
    // El intento y el «pendiente de email» quedan anotados ANTES de enviar: si la función muere enviando, cuenta y el barrido lo ve.
    await prisma.processedWebhookEvent.createMany({
      data: [
        { id: shopKey.due(id), processedAt: new Date(now) },
        { id: shopKey.attempt(id, attempt), processedAt: new Date(now) },
      ],
      skipDuplicates: true,
    });
    return { ok: true, attempt, lease: now };
  } catch (error) {
    await releaseShopLease(id).catch(() => {});
    throw error;
  }
}

/** Espera (en minutos) tras el intento n, como expresión SQL sobre `c.attempts` (los mismos tiempos que `backoffAfter`). */
const backoffCase = Prisma.raw(
  `CASE c.attempts WHEN 0 THEN ${EMAIL_FIRST_SWEEP_AFTER_MS / 60_000} ${EMAIL_BACKOFF_MS.map((ms, i) => `WHEN ${i + 1} THEN ${ms / 60_000}`).join(' ')} ELSE ${EMAIL_BACKOFF_MS[EMAIL_BACKOFF_MS.length - 1] / 60_000} END`
);

const shopCandidates = (since: Date) => Prisma.sql`
  WITH due AS (
    SELECT split_part("id", ':', 3) AS oid, "processedAt" AS due_at
    FROM "ProcessedWebhookEvent"
    WHERE "id" LIKE 'email:shop:%:due' AND "processedAt" >= ${since}
  ), tries AS (
    SELECT split_part("id", ':', 3) AS oid, count(*)::int AS attempts, max("processedAt") AS last_at
    FROM "ProcessedWebhookEvent"
    WHERE "id" LIKE 'email:shop:%:try:%'
    GROUP BY 1
  ), lease AS (
    SELECT split_part("id", ':', 3) AS oid, "processedAt" AS lease_at
    FROM "ProcessedWebhookEvent"
    WHERE "id" LIKE 'email:shop:%:lease'
  )
  SELECT d.oid AS id, COALESCE(t.attempts, 0) AS attempts, COALESCE(t.last_at, d.due_at) AS last_at, l.lease_at AS lease_at
  FROM due d
  JOIN "ShopOrder" o ON o."id" = d.oid AND o."status"::text IN ('PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED')
  LEFT JOIN tries t ON t.oid = d.oid
  LEFT JOIN lease l ON l.oid = d.oid
  WHERE NOT EXISTS (SELECT 1 FROM "ProcessedWebhookEvent" s WHERE s."id" = 'email:shop:' || d.oid)`;

// ── API pública de la capa ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function getEmailState(kind: EmailKind, id: string, now = Date.now()): Promise<EmailState | null> {
  return (await getEmailStates(kind, [id], now)).get(id) ?? null;
}

/** Estados de varios pedidos con UNA consulta (listados de admin). Los ids que no existen no aparecen en el mapa. */
export async function getEmailStates(kind: EmailKind, ids: string[], now = Date.now()): Promise<Map<string, EmailState>> {
  const out = new Map<string, EmailState>();
  if (ids.length === 0) return out;
  if (kind === 'entradas') {
    const rows = await prisma.order.findMany({ where: { id: { in: ids } }, select: orderSelect });
    for (const row of rows) out.set(row.id, orderState(row, now));
    return out;
  }
  const [orders, markers] = await Promise.all([prisma.shopOrder.findMany({ where: { id: { in: ids } }, select: { id: true } }), readShopMarkers(ids)]);
  for (const o of orders) out.set(o.id, shopState(o.id, markers.get(o.id) ?? emptyMarkers(), now));
  return out;
}

/** Anota que a este pedido pagado se le debe un email (tienda: crea el marcador `:due`; entradas: no hace falta, el propio pedido COMPLETED lo es). Idempotente. */
export async function trackEmail(kind: EmailKind, id: string, now = Date.now()): Promise<void> {
  if (kind === 'entradas') return;
  await prisma.processedWebhookEvent.createMany({ data: [{ id: shopKey.due(id), processedAt: new Date(now) }], skipDuplicates: true });
}

/**
 * Reclama el envío del email de un pedido: concesión atómica + anotación del intento. Solo quien recibe `{ ok: true }` puede enviar; el
 * resto sabe por qué no (`in_progress`: otro está enviando; `backoff`/`exhausted`: aún no toca o ya no; `already_sent`…).
 */
export async function claimEmailSend(kind: EmailKind, id: string, opts: ClaimOptions): Promise<ClaimResult> {
  return kind === 'entradas' ? claimOrder(id, opts) : claimShop(id, opts);
}

/** El envío se confirmó: marca el pedido como enviado y libera la concesión. */
export async function recordEmailSent(kind: EmailKind, id: string, now = Date.now()): Promise<void> {
  if (kind === 'entradas') {
    await prisma.order.updateMany({ where: { id }, data: { emailSentAt: new Date(now), emailLastError: null } });
    return;
  }
  await prisma.processedWebhookEvent.createMany({ data: [{ id: shopKey.sent(id), processedAt: new Date(now) }], skipDuplicates: true });
  await releaseShopLease(id);
}

/**
 * El envío falló: guarda un texto corto (entradas), libera la concesión y devuelve los intentos hechos y si se han agotado. `klass` decide su coste
 * (ver `EmailFailureClass`); `attempt` y `lease` son los del reclamo (`claimEmailSend`): con `lease`, un fallo de una concesión que ya caducó y relevó
 * otro NO pisa el estado del nuevo dueño.
 */
export async function recordEmailFailure(
  kind: EmailKind,
  id: string,
  error: string,
  opts: { klass?: EmailFailureClass; attempt?: number; lease?: number } = {}
): Promise<{ attempts: number; exhausted: boolean }> {
  const klass = opts.klass ?? 'normal';
  if (kind === 'entradas') {
    const owned = opts.lease !== undefined ? { emailLastError: `sending:${opts.lease}` } : {};
    const { count } = await prisma.order.updateMany({ where: { id, ...owned }, data: { emailLastError: sanitizeEmailError(error) } });
    if (count > 0) {
      // Sistémico: el sexto intento no cuenta (se queda en 5: backoff de 180 min, sin agotar). Permanente: agotado ya.
      if (klass === 'systemic' && opts.attempt === EMAIL_MAX_ATTEMPTS) await prisma.order.updateMany({ where: { id, emailAttempts: EMAIL_MAX_ATTEMPTS }, data: { emailAttempts: EMAIL_MAX_ATTEMPTS - 1 } });
      if (klass === 'permanent') await prisma.order.updateMany({ where: { id, emailAttempts: { lt: EMAIL_MAX_ATTEMPTS } }, data: { emailAttempts: EMAIL_MAX_ATTEMPTS } });
    }
    const row = await prisma.order.findUnique({ where: { id }, select: { emailAttempts: true } });
    const attempts = row?.emailAttempts ?? 0;
    return { attempts, exhausted: attempts >= EMAIL_MAX_ATTEMPTS };
  }
  await releaseShopLease(id, opts.lease);
  const now = new Date();
  if (klass === 'systemic' && opts.attempt === EMAIL_MAX_ATTEMPTS) {
    // El intento no cuenta: se borra su marcador y el anterior toma su hora (el backoff se mide desde el último intento).
    await prisma.processedWebhookEvent.deleteMany({ where: { id: shopKey.attempt(id, EMAIL_MAX_ATTEMPTS) } });
    await prisma.processedWebhookEvent.updateMany({ where: { id: shopKey.attempt(id, EMAIL_MAX_ATTEMPTS - 1) }, data: { processedAt: now } });
  }
  if (klass === 'permanent') {
    const from = opts.attempt ?? 1;
    await prisma.processedWebhookEvent.createMany({
      data: Array.from({ length: Math.max(0, EMAIL_MAX_ATTEMPTS - from + 1) }, (_, k) => ({ id: shopKey.attempt(id, from + k), processedAt: now })),
      skipDuplicates: true,
    });
  }
  const attempts = await prisma.processedWebhookEvent.count({ where: { id: { startsWith: `${shopKey.sent(id)}:try:` } } });
  return { attempts, exhausted: attempts >= EMAIL_MAX_ATTEMPTS };
}

export interface UnsentEntry {
  id: string;
  attempts: number;
}

/**
 * Pedidos pagados cuyo email NO está confirmado y a los que les toca un reintento automático AHORA (pasado el backoff, con intentos
 * pendientes, de los últimos días y sin una concesión viva). Más antiguos primero. El barrido del cron lo recorre; cada uno se reclama de
 * nuevo con `claimEmailSend`, que es quien decide.
 */
export async function listUnsent(kind: EmailKind, opts: { limit: number; now?: number }): Promise<UnsentEntry[]> {
  const now = opts.now ?? Date.now();
  const since = new Date(now - EMAIL_WINDOW_MS);
  if (kind === 'entradas') {
    const rows = await prisma.order.findMany({
      where: {
        status: 'COMPLETED',
        channel: 'ONLINE',
        emailSentAt: null,
        updatedAt: { gte: since },
        event: liveEventWhere(now),
        // Solo emails de pedidos online: la taquilla no envía email y las invitaciones tienen su propio envío manual.
        OR: [
          { emailAttempts: 0, updatedAt: { lte: new Date(now - EMAIL_FIRST_SWEEP_AFTER_MS) } },
          ...EMAIL_BACKOFF_MS.map((ms, i) => ({ emailAttempts: i + 1, updatedAt: { lte: new Date(now - ms) } })),
        ],
      },
      select: { id: true, emailAttempts: true },
      orderBy: { updatedAt: 'asc' },
      take: opts.limit,
    });
    return rows.map((r) => ({ id: r.id, attempts: r.emailAttempts }));
  }
  const rows = await prisma.$queryRaw<{ id: string; attempts: number }[]>(Prisma.sql`
    SELECT c.id, c.attempts FROM (${shopCandidates(since)}) c
    WHERE c.attempts < ${EMAIL_MAX_ATTEMPTS}
      AND (c.lease_at IS NULL OR c.lease_at < ${new Date(now - EMAIL_LEASE_MS)})
      AND c.last_at <= ${new Date(now)}::timestamp - (${backoffCase}) * interval '1 minute'
    ORDER BY c.last_at ASC
    LIMIT ${opts.limit}`);
  return rows.map((r) => ({ id: r.id, attempts: Number(r.attempts) }));
}

/**
 * Cuántos pedidos pagados tienen el email sin confirmar (`unsent`: con intentos pendientes, y con algún intento fallido o con más de 10
 * minutos sin que nadie lo intente; no cuenta los que están enviándose en este momento) y cuántos han agotado los intentos (`failed`).
 * Solo cuenta los de los últimos días. Es una consulta agregada, barata, para el bloque `ops` de /api/health.
 */
export async function countEmailBacklog(kind: EmailKind, opts: { now?: number } = {}): Promise<{ unsent: number; failed: number }> {
  const now = opts.now ?? Date.now();
  const since = new Date(now - EMAIL_WINDOW_MS);
  const leaseSince = new Date(now - EMAIL_LEASE_MS);
  const staleSince = new Date(now - EMAIL_UNSENT_AFTER_MS);
  const failedSince = new Date(now - EMAIL_FAILED_WINDOW_MS);
  if (kind === 'entradas') {
    const base = { status: 'COMPLETED' as const, channel: 'ONLINE', emailSentAt: null, event: liveEventWhere(now) };
    const [unsent, failed] = await Promise.all([
      prisma.order.count({
        where: {
          ...base,
          updatedAt: { gte: since },
          emailAttempts: { lt: EMAIL_MAX_ATTEMPTS },
          AND: [
            { OR: [{ emailLastError: null }, { NOT: { emailLastError: { startsWith: 'sending:' } } }, { updatedAt: { lte: leaseSince } }] },
            { OR: [{ emailAttempts: { gt: 0 } }, { updatedAt: { lt: staleSince } }] },
          ],
        },
      }),
      prisma.order.count({ where: { ...base, updatedAt: { gte: failedSince }, emailAttempts: { gte: EMAIL_MAX_ATTEMPTS } } }),
    ]);
    return { unsent, failed };
  }
  const rows = await prisma.$queryRaw<{ unsent: number; failed: number }[]>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE c.attempts < ${EMAIL_MAX_ATTEMPTS}
        AND (c.lease_at IS NULL OR c.lease_at < ${leaseSince})
        AND (c.attempts > 0 OR c.last_at < ${staleSince}))::int AS unsent,
      count(*) FILTER (WHERE c.attempts >= ${EMAIL_MAX_ATTEMPTS} AND c.last_at >= ${failedSince})::int AS failed
    FROM (${shopCandidates(since)}) c`);
  return { unsent: Number(rows[0]?.unsent ?? 0), failed: Number(rows[0]?.failed ?? 0) };
}
