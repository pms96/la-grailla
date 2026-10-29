import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { getOperatorEmail } from '@/lib/config';
import { invalidateOrder } from '@/lib/reconciliation/entradas';
import { eventCancelledEmail, eventDateChangedEmail, type CancellationMailKind } from '@/lib/event-notices';

/* Cancelar un evento o cambiarle la fecha cuando ya hay compradores (auditoría P1-04 / EN-09).
 *
 * Con cientos de pedidos no cabe en una petición (reembolsar es una llamada a la pasarela por pedido, y enviar un email otra), así que es un TRABAJO
 * REANUDABLE: el admin lo lanza, se procesa un primer lote en la misma petición y el resto sigue en cada pasada del cron de reconciliación (cada pocos
 * minutos) o cuando el admin pulsa «Continuar». No hay migración: la intención del admin (reembolsar o no, avisar o no) y los fallos viven en una fila de
 * sistema de AppConfig (`event_cancellation:<id>`), y «a quién ya se avisó» en filas marcadoras de ProcessedWebhookEvent (`event-cancel-mail:<pedido>`),
 * igual que el email de la tienda. Todo es IDEMPOTENTE: relanzar un lote no reembolsa dos veces (el reembolso reclama el estado del pedido con un
 * compare-and-swap en `invalidateOrder`) ni avisa dos veces (el marcador se reclama ANTES de enviar y se libera si el envío falla).
 *
 * Qué se reembolsa solo: pedidos COMPLETED pagados con tarjeta en una pasarela real, con pago asociado y sin entradas ya usadas. Efectivo, gratuitos y
 * pedidos con entradas ya usadas NO: quedan para el organizador y se les avisa de que lo gestiona él. Un reembolso que falla se reintenta hasta
 * MAX_REFUND_ATTEMPTS veces y después se da por «a mano» (y así se dice al comprador y al admin). */

export const CANCELLATION_JOB_PREFIX = 'event_cancellation:';
export const DATE_CHANGE_JOB_PREFIX = 'event_datechange:';
const CANCEL_MAIL_PREFIX = 'event-cancel-mail:';
const DATE_MAIL_PREFIX = 'event-date-mail:';

export const MAX_REFUND_ATTEMPTS = 3;
export const MAX_MAIL_ATTEMPTS = 5;
/** Espera entre intentos tras un fallo (ms), por número de fallos acumulados. Con el diálogo sondeando cada segundo, contar solo «pasadas» agotaba los intentos en segundos. */
const REFUND_BACKOFF_MS = [2 * 60_000, 10 * 60_000];
const MAIL_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Tope de tiempo de UNA llamada de reembolso (la de la pasarela puede tardar 80 s, más que `maxDuration`): pasado, cuenta como fallo y se reintenta más tarde. */
const DEFAULT_CALL_CAP_MS = 25_000;
const backoff = (table: number[], failures: number) => table[Math.min(failures, table.length) - 1] ?? table[table.length - 1];
const DEFAULT_CONCURRENCY = 4;
const BATCH = 100;

export interface CancellationJob {
  v: 1;
  /** Reembolsar automáticamente los pagos con tarjeta. */
  refund: boolean;
  /** Avisar por email a los compradores online. */
  notify: boolean;
  startedAt: string;
  startedBy: string | null;
  doneAt: string | null;
  /** Reembolsos que fallaron: pedido → intentos, último error (corto) y cuándo se puede reintentar. Solo los que fallan, no todos. */
  failed: Record<string, { attempts: number; error: string; nextAt?: number }>;
  /** Envíos fallidos por pedido: intentos y cuándo se puede reintentar. */
  mailFailed: Record<string, { attempts: number; nextAt: number }>;
}

export interface DateChangeJob {
  v: 1;
  oldDate: string;
  newDate: string;
  /** Identifica ESTE cambio de fecha en los marcadores (si la fecha vuelve a cambiar, se avisa de nuevo). */
  tag: string;
  startedAt: string;
  doneAt: string | null;
  mailFailed: Record<string, { attempts: number; nextAt: number }>;
}

const cancelKey = (eventId: string) => `${CANCELLATION_JOB_PREFIX}${eventId}`;
const dateKey = (eventId: string) => `${DATE_CHANGE_JOB_PREFIX}${eventId}`;

async function readJson<T>(key: string): Promise<T | null> {
  const row = await prisma.appConfig.findUnique({ where: { key }, select: { value: true } });
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await prisma.appConfig.upsert({ where: { key }, update: { value: json }, create: { key, value: json, label: key, group: 'system' } });
}

/** Ejecuta `fn` sobre los elementos con tope de concurrencia y sin empezar ninguno pasado el plazo. */
async function mapLimit<T>(items: T[], concurrency: number, deadline: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return;
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]).catch((error) => console.error('[event-cancellation] error en un elemento:', error instanceof Error ? error.message : error));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

/** Corta la espera de una llamada que se cuelga (la de la pasarela puede tardar más que `maxDuration`): pasado el tope cuenta como fallo y se reintenta más tarde. */
async function withCap(call: Promise<{ success: boolean; error?: string }>, capMs: number): Promise<{ success: boolean; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([call, new Promise<{ success: boolean; error?: string }>((resolve) => (timer = setTimeout(() => resolve({ success: false, error: 'la pasarela no responde (tiempo agotado)' }), capMs)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const isRealEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.endsWith('.local');

/** Criterio único de «este pedido se puede reembolsar solo». */
const REFUNDABLE_WHERE = {
  status: 'COMPLETED' as const,
  paymentMethod: 'CARD' as const,
  paymentId: { not: null },
  AND: [{ paymentProvider: { not: null } }, { paymentProvider: { not: 'mock' } }],
  tickets: { none: { status: 'USED' as const } },
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Vista previa y estado
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface CancellationPreview {
  /** Pedidos pagados con tarjeta que se pueden reembolsar solos. */
  refundable: { count: number; amount: number };
  /** Pedidos completados con alguna entrada ya usada: no se reembolsan solos. */
  withUsedTickets: number;
  /** Pedidos completados que NO se reembolsan solos (efectivo, gratuitos, invitaciones, entradas usadas): el organizador lo gestiona. */
  manualOrGratis: { count: number; amount: number };
  /** Pedidos sin pagar: se anulan y se cierra su sesión de pago. */
  pending: number;
  /** Compradores online a los que se puede avisar por email. */
  notifiable: number;
}

export async function previewCancellation(eventId: string): Promise<CancellationPreview> {
  const [refundable, completed, withUsed, pending, notifiable] = await Promise.all([
    prisma.order.aggregate({ where: { eventId, ...REFUNDABLE_WHERE }, _count: true, _sum: { totalAmount: true } }),
    prisma.order.aggregate({ where: { eventId, status: 'COMPLETED' }, _count: true, _sum: { totalAmount: true } }),
    prisma.order.count({ where: { eventId, status: 'COMPLETED', tickets: { some: { status: 'USED' } } } }),
    prisma.order.count({ where: { eventId, status: 'PENDING' } }),
    prisma.order.count({ where: { eventId, status: { in: ['COMPLETED', 'REFUNDED'] }, channel: 'ONLINE' } }),
  ]);
  const refundableAmount = Number(refundable._sum.totalAmount ?? 0);
  const completedAmount = Number(completed._sum.totalAmount ?? 0);
  return {
    refundable: { count: refundable._count, amount: refundableAmount },
    withUsedTickets: withUsed,
    manualOrGratis: { count: completed._count - refundable._count, amount: Math.round((completedAmount - refundableAmount) * 100) / 100 },
    pending,
    notifiable,
  };
}

export interface CancellationProgress {
  job: Pick<CancellationJob, 'refund' | 'notify' | 'startedAt' | 'doneAt'>;
  done: boolean;
  /** Pedidos reembolsados (estado REFUNDED) del evento. */
  refunded: number;
  /** Reembolsos que aún faltan por intentar. */
  refundsRemaining: number;
  /** Pedidos sin pagar aún por anular. */
  pendingToCancel: number;
  emailsSent: number;
  emailsRemaining: number;
  /** Avisos que agotaron sus intentos (SMTP caído, límite de envío…): no se reintentan más, el admin debe saberlo. */
  emailsFailed: number;
  /** Cuándo vuelve a intentarse lo que falló (ISO), si hay algo esperando. El diálogo deja de sondear hasta entonces. */
  retryAt: string | null;
  /** Pedidos que hay que resolver a mano (reembolso fallido tras los reintentos, a medias, o con entradas ya usadas) y avisos sin enviar. */
  manual: { orderId: string; reason: string }[];
}

async function countMarkers(prefix: string, eventId: string, suffix = ''): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM "ProcessedWebhookEvent" p JOIN "Order" o ON p."id" = ${prefix} || o."id" || ${suffix}::text WHERE o."eventId" = ${eventId}`;
  return rows[0]?.n ?? 0;
}

type MailCandidate = {
  id: string;
  buyerName: string;
  buyerEmail: string;
  totalAmount: number;
  status: string;
  paymentMethod: string;
  paymentProvider: string | null;
  paymentId: string | null;
  hasUsed: boolean;
  /** Tiene alguna entrada aún VALID/PENDING: un pedido REFUNDED con entradas activas está a medias (el reembolso aún no ha terminado, o murió a medias). */
  hasActive: boolean;
};

/** Pedidos online del evento SIN marcador de aviso. Prisma no sabe expresar «sin fila marcadora», de ahí el SQL. `limit` y los marcadores van parametrizados. */
async function unmailedOrders(prefix: string, suffix: string, eventId: string, statuses: string[], limit: number, refundedSince: Date = new Date(0)): Promise<MailCandidate[]> {
  const rows = await prisma.$queryRaw<(Omit<MailCandidate, 'totalAmount'> & { totalAmount: unknown })[]>`
    SELECT o."id", o."buyerName", o."buyerEmail", o."totalAmount", o."status"::text AS "status", o."paymentMethod"::text AS "paymentMethod", o."paymentProvider", o."paymentId",
           EXISTS (SELECT 1 FROM "Ticket" t WHERE t."orderId" = o."id" AND t."status" = 'USED') AS "hasUsed",
           EXISTS (SELECT 1 FROM "Ticket" t WHERE t."orderId" = o."id" AND t."status" IN ('VALID', 'PENDING')) AS "hasActive"
    FROM "Order" o
    WHERE o."eventId" = ${eventId} AND o."channel" = 'ONLINE' AND o."status"::text = ANY(${statuses}::text[])
      -- un pedido reembolsado ANTES de cancelar el evento ya tuvo su aviso en su día: solo cuentan los reembolsados desde que empezó este trabajo
      AND (o."status"::text <> 'REFUNDED' OR o."updatedAt" >= ${refundedSince})
      AND NOT EXISTS (SELECT 1 FROM "ProcessedWebhookEvent" p WHERE p."id" = ${prefix} || o."id" || ${suffix}::text)
    ORDER BY o."createdAt" ASC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, totalAmount: Number(r.totalAmount) }));
}

/** ¿Está este pedido en un estado FINAL como para avisar de lo que pasa con su dinero? null = aún falta (p. ej. su reembolso). */
export function cancellationMailKind(
  o: Pick<MailCandidate, 'status' | 'paymentMethod' | 'paymentProvider' | 'paymentId' | 'totalAmount' | 'hasUsed' | 'id'> & { hasActive?: boolean },
  job: Pick<CancellationJob, 'refund' | 'failed'>
): CancellationMailKind | null {
  // REFUNDED con entradas aún activas = el reembolso está en vuelo (invalidateOrder marca el pedido ANTES de llamar a la pasarela y lo revierte si falla):
  // todavía no se puede decir «hemos devuelto».
  if (o.status === 'REFUNDED') return o.hasActive ? null : 'refunded';
  if (o.status !== 'COMPLETED') return null;
  if (!(o.totalAmount > 0)) return 'free';
  const refundable = o.paymentMethod === 'CARD' && !!o.paymentProvider && o.paymentProvider !== 'mock' && !!o.paymentId && !o.hasUsed;
  if (!refundable) return 'manual';
  if (!job.refund) return 'manual';
  const failed = job.failed[o.id];
  return failed && failed.attempts >= MAX_REFUND_ATTEMPTS ? 'manual' : null;
}

export async function cancellationProgress(eventId: string, jobIn?: CancellationJob | null): Promise<CancellationProgress | null> {
  const job = jobIn ?? (await readJson<CancellationJob>(cancelKey(eventId)));
  if (!job) return null;
  const since = new Date(job.startedAt);
  const exhausted = Object.entries(job.failed).filter(([, f]) => f.attempts >= MAX_REFUND_ATTEMPTS).map(([id]) => id);
  const [refunded, refundsRemaining, pendingToCancel, emailsSent, unmailed, usedCompleted, halfRefunded] = await Promise.all([
    prisma.order.count({ where: { eventId, status: 'REFUNDED', updatedAt: { gte: since } } }),
    job.refund ? prisma.order.count({ where: { eventId, ...REFUNDABLE_WHERE, id: { notIn: exhausted } } }) : Promise.resolve(0),
    prisma.order.count({ where: { eventId, status: 'PENDING' } }),
    countMarkers(CANCEL_MAIL_PREFIX, eventId),
    job.notify ? unmailedOrders(CANCEL_MAIL_PREFIX, '', eventId, ['COMPLETED', 'REFUNDED'], 2000, since) : Promise.resolve([] as MailCandidate[]),
    prisma.order.findMany({ where: { eventId, status: 'COMPLETED', tickets: { some: { status: 'USED' } }, totalAmount: { gt: 0 } }, select: { id: true }, take: 50 }),
    prisma.order.findMany({ where: { eventId, status: 'REFUNDED', updatedAt: { gte: since }, tickets: { some: { status: { in: ['VALID', 'PENDING'] } } } }, select: { id: true }, take: 50 }),
  ]);
  const pendingMail = unmailed.filter((o) => isRealEmail(o.buyerEmail) && cancellationMailKind(o, job) !== null);
  const emailsRemaining = pendingMail.filter((o) => (job.mailFailed[o.id]?.attempts ?? 0) < MAX_MAIL_ATTEMPTS).length;
  const mailExhausted = pendingMail.filter((o) => (job.mailFailed[o.id]?.attempts ?? 0) >= MAX_MAIL_ATTEMPTS);
  const now = Date.now();
  const waiting = [
    ...Object.values(job.failed).filter((f) => f.attempts < MAX_REFUND_ATTEMPTS && (f.nextAt ?? 0) > now).map((f) => f.nextAt as number),
    ...Object.entries(job.mailFailed).filter(([, f]) => f.attempts < MAX_MAIL_ATTEMPTS && f.nextAt > now).map(([, f]) => f.nextAt),
  ];
  const manual: CancellationProgress['manual'] = [
    ...Object.entries(job.failed).filter(([, f]) => f.attempts >= MAX_REFUND_ATTEMPTS).map(([orderId, f]) => ({ orderId, reason: `Reembolso fallido: ${f.error}` })),
    ...halfRefunded.map((o) => ({ orderId: o.id, reason: 'Reembolso a medias (el pedido consta reembolsado pero sus entradas siguen activas): revisa el cobro en la pasarela' })),
    ...usedCompleted.map((o) => ({ orderId: o.id, reason: 'Tiene entradas ya usadas: no se reembolsa solo' })),
    ...mailExhausted.map((o) => ({ orderId: o.id, reason: 'No se pudo enviar el aviso por email (revisa el SMTP): avísale tú' })),
  ];
  return {
    job: { refund: job.refund, notify: job.notify, startedAt: job.startedAt, doneAt: job.doneAt },
    done: job.doneAt !== null,
    refunded,
    refundsRemaining,
    pendingToCancel,
    emailsSent,
    emailsRemaining,
    emailsFailed: mailExhausted.length,
    retryAt: waiting.length > 0 ? new Date(Math.min(...waiting)).toISOString() : null,
    manual,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Cancelar el evento
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Marca el evento como CANCELADO (cierra ya la venta y el escáner) y deja anotado el trabajo. NO procesa pedidos: de eso se ocupa `processCancellation`.
 * Si ya hay un trabajo para este evento lo conserva (no se pisan las opciones ni los fallos de uno en marcha).
 */
export async function startCancellation(eventId: string, opts: { refund: boolean; notify: boolean; startedBy: string | null }): Promise<CancellationJob> {
  const existing = await readJson<CancellationJob>(cancelKey(eventId));
  const reuse = existing && !existing.doneAt ? existing : null;
  const job: CancellationJob = reuse ?? { v: 1, refund: opts.refund, notify: opts.notify, startedAt: new Date().toISOString(), startedBy: opts.startedBy, doneAt: null, failed: {}, mailFailed: {} };
  // El trabajo se anota ANTES de cambiar el estado: si lo segundo fallara, un evento cancelado sin trabajo no lo vería nadie (ni el cron).
  if (!reuse) await writeJson(cancelKey(eventId), job);
  try {
    await prisma.event.update({ where: { id: eventId }, data: { status: 'CANCELLED' } });
  } catch (error) {
    if (!reuse) await prisma.appConfig.deleteMany({ where: { key: cancelKey(eventId) } }).catch(() => undefined);
    throw error;
  }
  return job;
}

/** ¿Se canceló este evento con el flujo de cancelación (hay trabajo anotado)? Sirve para no «descancelarlo» sin más: ya se reembolsó y se avisó. */
export async function hasCancellationJob(eventId: string): Promise<boolean> {
  return (await prisma.appConfig.count({ where: { key: cancelKey(eventId) } })) > 0;
}

/** Un lote del trabajo de cancelación: anula los pendientes, reembolsa, avisa; y lo da por terminado si no queda nada. Nunca lanza. */
export async function processCancellation(eventId: string, opts: { deadline: number; concurrency?: number; callCapMs?: number }): Promise<CancellationProgress | null> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const callCapMs = opts.callCapMs ?? DEFAULT_CALL_CAP_MS;
  let job: CancellationJob | null;
  try {
    job = await readJson<CancellationJob>(cancelKey(eventId));
  } catch (error) {
    console.error('[event-cancellation] no se pudo leer el trabajo:', error instanceof Error ? error.message : error);
    return null;
  }
  if (!job) return null;
  if (job.doneAt) return cancellationProgress(eventId, job);
  const live: CancellationJob = job;

  try {
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { name: true, date: true, status: true } });
    if (!event) {
      live.doneAt = new Date().toISOString();
      await writeJson(cancelKey(eventId), live);
      return null;
    }
    // Si alguien volvió a publicar el evento, el trabajo ya no tiene sentido: se cierra sin tocar nada más.
    if (event.status !== 'CANCELLED') {
      live.doneAt = new Date().toISOString();
      await writeJson(cancelKey(eventId), live);
      return cancellationProgress(eventId, live);
    }

    // 1) Pedidos sin pagar: se anulan (y se cierra su sesión de pago, para que no se puedan pagar ya).
    const pending = await prisma.order.findMany({ where: { eventId, status: 'PENDING' }, select: { id: true }, take: BATCH });
    await mapLimit(pending, concurrency, opts.deadline, async (o) => {
      await withCap(invalidateOrder(o.id, 'CANCELLED'), callCapMs);
    });

    // 2) Reembolsos.
    if (live.refund) {
      const exhausted = Object.entries(live.failed).filter(([, f]) => f.attempts >= MAX_REFUND_ATTEMPTS).map(([id]) => id);
      const now = Date.now();
      // Los que fallaron hace poco esperan su turno (con el diálogo sondeando cada segundo, reintentar sin espera agotaba los intentos en segundos).
      const waiting = Object.entries(live.failed).filter(([, f]) => (f.nextAt ?? 0) > now).map(([id]) => id);
      const refundable = await prisma.order.findMany({ where: { eventId, ...REFUNDABLE_WHERE, id: { notIn: [...exhausted, ...waiting] } }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: BATCH });
      await mapLimit(refundable, concurrency, opts.deadline, async (o) => {
        const result = await withCap(invalidateOrder(o.id, 'REFUNDED'), callCapMs);
        if (result.success) {
          delete live.failed[o.id];
          return;
        }
        const attempts = (live.failed[o.id]?.attempts ?? 0) + 1;
        live.failed[o.id] = { attempts, error: String(result.error ?? 'error').slice(0, 160), nextAt: Date.now() + backoff(REFUND_BACKOFF_MS, attempts) };
      });
    }

    // 3) Avisos por email, solo de los pedidos ya en estado final.
    if (live.notify) {
      const contactEmail = (await getOperatorEmail('entradas').catch(() => '')) || null;
      const nowMail = Date.now();
      const candidates = (await unmailedOrders(CANCEL_MAIL_PREFIX, '', eventId, ['COMPLETED', 'REFUNDED'], BATCH, new Date(live.startedAt))).filter((o) => {
        const f = live.mailFailed[o.id];
        return isRealEmail(o.buyerEmail) && cancellationMailKind(o, live) !== null && (f?.attempts ?? 0) < MAX_MAIL_ATTEMPTS && (f?.nextAt ?? 0) <= nowMail;
      });
      await mapLimit(candidates, concurrency, opts.deadline, async (o) => {
        const kind = cancellationMailKind(o, live)!;
        const marker = `${CANCEL_MAIL_PREFIX}${o.id}`;
        // Se reclama el marcador ANTES de enviar: de dos pasadas simultáneas solo una avisa. Si el envío falla se libera para reintentarlo.
        const claim = await prisma.processedWebhookEvent.createMany({ data: [{ id: marker }], skipDuplicates: true });
        if (claim.count === 0) return;
        const { subject, html } = await eventCancelledEmail({ buyerName: o.buyerName, eventName: event.name, eventDate: event.date, kind, amount: o.totalAmount, contactEmail });
        const sent = await sendMail({ to: o.buyerEmail, subject, html, ...(contactEmail ? { replyTo: contactEmail } : {}) });
        if (!sent.success) {
          await prisma.processedWebhookEvent.deleteMany({ where: { id: marker } });
          const attempts = (live.mailFailed[o.id]?.attempts ?? 0) + 1;
          live.mailFailed[o.id] = { attempts, nextAt: Date.now() + backoff(MAIL_BACKOFF_MS, attempts) };
        }
      });
    }

    // 4) ¿Queda algo?
    const progress = await cancellationProgress(eventId, live);
    if (progress && progress.pendingToCancel === 0 && progress.refundsRemaining === 0 && (!live.notify || progress.emailsRemaining === 0)) {
      live.doneAt = new Date().toISOString();
      progress.done = true;
      progress.job.doneAt = live.doneAt;
    }
    await writeJson(cancelKey(eventId), live);
    return progress;
  } catch (error) {
    console.error('[event-cancellation] error procesando la cancelación:', error instanceof Error ? error.message : error);
    try {
      await writeJson(cancelKey(eventId), live);
    } catch {
      /* se reintenta en la siguiente pasada */
    }
    return cancellationProgress(eventId, live).catch(() => null);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Cambio de fecha
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Compradores online con pedido completado: a quienes se puede avisar de un cambio de fecha. */
export async function countDateChangeRecipients(eventId: string): Promise<number> {
  return prisma.order.count({ where: { eventId, status: 'COMPLETED', channel: 'ONLINE' } });
}

/** Anota el aviso de cambio de fecha (cada cambio distinto es un aviso distinto). */
export async function startDateChangeNotice(eventId: string, oldDate: Date, newDate: Date): Promise<DateChangeJob> {
  // Si el aviso anterior aún no terminó, los que faltan por avisar conocen la fecha ORIGINAL, no la intermedia: se conserva como «antes».
  const previous = await readJson<DateChangeJob>(dateKey(eventId));
  const from = previous && !previous.doneAt ? previous.oldDate : oldDate.toISOString();
  // La etiqueta es única por cambio (A→B→A→B no reutiliza el marcador del primer B).
  const job: DateChangeJob = { v: 1, oldDate: from, newDate: newDate.toISOString(), tag: `${newDate.getTime()}-${Date.now()}`, startedAt: new Date().toISOString(), doneAt: null, mailFailed: {} };
  await writeJson(dateKey(eventId), job);
  return job;
}

export interface DateChangeProgress {
  done: boolean;
  sent: number;
  remaining: number;
}

/** Un lote de avisos de cambio de fecha. Nunca lanza. */
export async function processDateChange(eventId: string, opts: { deadline: number; concurrency?: number }): Promise<DateChangeProgress | null> {
  try {
    const job = await readJson<DateChangeJob>(dateKey(eventId));
    if (!job) return null;
    const suffix = `:${job.tag}`;
    const pendingMails = async () =>
      (await unmailedOrders(DATE_MAIL_PREFIX, suffix, eventId, ['COMPLETED'], 5000)).filter((o) => isRealEmail(o.buyerEmail) && (job.mailFailed[o.id]?.attempts ?? 0) < MAX_MAIL_ATTEMPTS);
    if (!job.doneAt) {
      const event = await prisma.event.findUnique({ where: { id: eventId }, select: { name: true, status: true } });
      if (!event || event.status === 'CANCELLED') {
        job.doneAt = new Date().toISOString(); // un evento cancelado ya recibe su propio aviso
        await writeJson(dateKey(eventId), job);
      } else {
        const contactEmail = (await getOperatorEmail('entradas').catch(() => '')) || null;
        const nowMail = Date.now();
        const candidates = (await pendingMails()).filter((o) => (job.mailFailed[o.id]?.nextAt ?? 0) <= nowMail).slice(0, BATCH);
        await mapLimit(candidates, opts.concurrency ?? DEFAULT_CONCURRENCY, opts.deadline, async (o) => {
          const marker = `${DATE_MAIL_PREFIX}${o.id}${suffix}`;
          const claim = await prisma.processedWebhookEvent.createMany({ data: [{ id: marker }], skipDuplicates: true });
          if (claim.count === 0) return;
          const { subject, html } = await eventDateChangedEmail({ buyerName: o.buyerName, eventName: event.name, oldDate: new Date(job.oldDate), newDate: new Date(job.newDate), contactEmail });
          const sent = await sendMail({ to: o.buyerEmail, subject, html, ...(contactEmail ? { replyTo: contactEmail } : {}) });
          if (!sent.success) {
            await prisma.processedWebhookEvent.deleteMany({ where: { id: marker } });
            const attempts = (job.mailFailed[o.id]?.attempts ?? 0) + 1;
            job.mailFailed[o.id] = { attempts, nextAt: Date.now() + backoff(MAIL_BACKOFF_MS, attempts) };
          }
        });
        if ((await pendingMails()).length === 0) job.doneAt = new Date().toISOString();
        await writeJson(dateKey(eventId), job);
      }
    }
    const sent = await countMarkers(DATE_MAIL_PREFIX, eventId, suffix);
    const remaining = job.doneAt ? 0 : (await pendingMails()).length;
    return { done: job.doneAt !== null, sent, remaining };
  } catch (error) {
    console.error('[event-cancellation] error en el aviso de cambio de fecha:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Barrido del cron
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface EventNoticeSweepResult {
  cancellations: number;
  dateChanges: number;
}

/** Continúa los trabajos de cancelación y de cambio de fecha sin terminar. Lo llama el cron de reconciliación con un presupuesto de tiempo propio. Nunca lanza. */
export async function runEventNoticeSweep(opts: { deadline: number; concurrency?: number }): Promise<EventNoticeSweepResult> {
  const out: EventNoticeSweepResult = { cancellations: 0, dateChanges: 0 };
  try {
    const rows = await prisma.appConfig.findMany({
      // Solo los SIN terminar y en la propia consulta: las filas terminadas se quedan (historial) y, filtradas después en JS, acabarían llenando el `take`
      // y dejando fuera trabajos nuevos.
      where: { OR: [{ key: { startsWith: CANCELLATION_JOB_PREFIX } }, { key: { startsWith: DATE_CHANGE_JOB_PREFIX } }], value: { contains: '"doneAt":null' } },
      select: { key: true, value: true },
      orderBy: { key: 'asc' },
      take: 50,
    });
    for (const row of rows) {
      if (Date.now() >= opts.deadline) break;
      let doneAt: unknown;
      try {
        doneAt = (JSON.parse(row.value) as { doneAt?: unknown }).doneAt;
      } catch {
        continue;
      }
      if (doneAt) continue;
      if (row.key.startsWith(CANCELLATION_JOB_PREFIX)) {
        await processCancellation(row.key.slice(CANCELLATION_JOB_PREFIX.length), { ...opts, callCapMs: 8_000 });
        out.cancellations += 1;
      } else {
        await processDateChange(row.key.slice(DATE_CHANGE_JOB_PREFIX.length), opts);
        out.dateChanges += 1;
      }
    }
  } catch (error) {
    console.error('[event-cancellation] error en el barrido:', error instanceof Error ? error.message : error);
  }
  return out;
}
