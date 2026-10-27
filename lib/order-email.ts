import { after } from 'next/server';
import { escapeHtml as esc } from '@/lib/html-escape';
import { currentTenant, runWithTenant } from '@/lib/tenant/context';
import { rateLimit } from '@/lib/rate-limit';
import { alertOperator, logPaymentEvent } from '@/lib/reconciliation/shared';
import {
  EMAIL_PENDING_STALE_MS,
  claimEmailSend,
  listUnsent,
  recordEmailFailure,
  recordEmailSent,
  sanitizeEmailError,
  type ClaimSkipReason,
  type EmailFailureClass,
  type EmailKind,
  type EmailState,
} from '@/lib/email-delivery';

/* UN solo punto de envío del email de un pedido (P0-08), por tipo de pedido. Todos los disparadores —el webhook de cobro, la verificación al
 * abrir la confirmación, el barrido del cron, el botón «reenviar» del comprador y del admin— pasan por `sendOrderEmail`:
 *   1. reclama la concesión atómica (lib/email-delivery.ts: de N disparadores simultáneos solo uno envía, el resto recibe `in_progress`);
 *   2. construye y envía (PDF y pases para entradas; líneas y enlace para tienda) con los tiempos máximos del SMTP;
 *   3. anota el resultado: enviado, o fallo corto sin datos personales. Los fallos SISTÉMICOS (sin SMTP, conexión, tiempo, credenciales) no agotan el pedido;
 *      los PERMANENTES del destinatario (rechazo, errata) sí, enseguida. Los avisos al operador son UNO agregado por pasada y día (`alertEmailProblems`).
 * Nunca lanza: el email es una consecuencia del pago, no puede tumbar el webhook ni la pantalla. */

export type SendOrderEmailResult =
  | { status: 'sent'; attempt: number }
  | { status: 'failed'; attempt: number; error: string; exhausted: boolean; failureClass: EmailFailureClass; errorCode?: string }
  | { status: 'skipped'; reason: ClaimSkipReason }
  /** No se pudo ni reclamar el envío (la BD no respondió): nada se ha enviado ni anotado. Reintentable. */
  | { status: 'error'; error: 'claim_failed' };

export interface SendOrderEmailOptions {
  baseUrl?: string;
  /** auto: disparadores y barrido (respetan backoff y máximo). manual: admin/comprador (los saltan). */
  mode?: 'auto' | 'manual';
  /** Volver a enviar aunque ya conste enviado. */
  resend?: boolean;
  /** Tope DURO de tiempo del envío (ms): pasado, se da por fallido (sistémico), se libera la concesión y se sigue. El SMTP ya tiene timeouts de inactividad, pero no uno total. */
  capMs?: number;
}

const SYSTEMIC_CODES = new Set(['smtp_not_configured', 'config_unavailable', 'smtp_unavailable']);

/** Clase de un fallo de envío según el `errorCode` del mailer (ver `EmailFailureClass`). Sin código (una excepción propia, p. ej. el PDF) = normal. */
export function classifyEmailFailure(errorCode?: string | null): EmailFailureClass {
  if (errorCode && SYSTEMIC_CODES.has(errorCode)) return 'systemic';
  if (errorCode === 'smtp_rejected') return 'permanent';
  return 'normal';
}

type DeliverOutcome = { success: boolean; error?: string; errorCode?: string };

const TAG = '[order-email]';

export async function sendOrderEmail(kind: EmailKind, id: string, opts: SendOrderEmailOptions = {}): Promise<SendOrderEmailResult> {
  let claim;
  try {
    claim = await claimEmailSend(kind, id, { mode: opts.mode ?? 'auto', resend: opts.resend });
  } catch (error) {
    // Honesto: no se ha reclamado ni enviado nada (antes se devolvía «en curso», y el botón del comprador decía «te lo estamos enviando» sin hacerlo).
    logPaymentEvent(TAG, { kind, orderId: id, reason: 'claim_failed', error: error instanceof Error ? error.message.slice(0, 160) : 'desconocido' });
    return { status: 'error', error: 'claim_failed' };
  }
  if (!claim.ok) return { status: 'skipped', reason: claim.reason };

  // Carga perezosa: confirmar un pedido de tienda no importa nada de entradas (PDF, wallet) y al revés.
  const deliver: Promise<DeliverOutcome> = (async () => {
    try {
      return kind === 'entradas'
        ? await (await import('@/lib/tickets')).deliverTicketsEmail(id, opts.baseUrl)
        : await (await import('@/lib/shop/order-email')).deliverShopOrderEmail(id, opts.baseUrl);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();
  let outcome: DeliverOutcome;
  if (opts.capMs && opts.capMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), opts.capMs)));
    const first = await Promise.race([deliver, timeout]);
    if (timer) clearTimeout(timer);
    if (first === 'timeout') {
      outcome = { success: false, error: `smtp_unavailable: el envío no terminó en ${Math.round(opts.capMs / 1000)} s`, errorCode: 'smtp_unavailable' };
      // Si el SMTP acaba aceptándolo más tarde, que conste enviado (mejor eso que un reenvío); si la función ya no está viva, el barrido lo reintentará.
      void deliver.then((late) => (late.success ? recordEmailSent(kind, id) : undefined)).catch(() => {});
    } else {
      outcome = first;
    }
  } else {
    outcome = await deliver;
  }
  // Lo que se guarda y se registra nunca lleva direcciones de correo ni más de una línea corta.
  if (!outcome.success) outcome = { ...outcome, success: false, error: sanitizeEmailError(outcome.error) };

  try {
    if (outcome.success) {
      await recordEmailSent(kind, id);
      return { status: 'sent', attempt: claim.attempt };
    }
    const error = outcome.error ?? 'Error desconocido al enviar';
    const failureClass = classifyEmailFailure(outcome.errorCode);
    const { attempts, exhausted } = await recordEmailFailure(kind, id, error, { klass: failureClass, attempt: claim.attempt, lease: claim.lease });
    logPaymentEvent(TAG, { kind, orderId: id, reason: 'email_attempt_failed', attempt: claim.attempt, failureClass, errorCode: outcome.errorCode ?? null, error: error.slice(0, 160) }, 'warn');
    // El detalle por pedido queda en el log; el AVISO al operador es uno agregado por pasada y día (`alertEmailProblems`, lo dispara el barrido).
    if (exhausted) logPaymentEvent(TAG, { kind, orderId: id, reason: 'email_exhausted', attempts, failureClass, errorCode: outcome.errorCode ?? null });
    return { status: 'failed', attempt: claim.attempt, error, exhausted, failureClass, errorCode: outcome.errorCode };
  } catch (error) {
    // Si lo que falla es anotar el resultado, la concesión caduca sola y el barrido lo recupera.
    logPaymentEvent(TAG, { kind, orderId: id, reason: 'record_failed', error: error instanceof Error ? error.message.slice(0, 160) : 'desconocido' });
    return outcome.success
      ? { status: 'sent', attempt: claim.attempt }
      : { status: 'failed', attempt: claim.attempt, error: outcome.error ?? 'Error desconocido al enviar', exhausted: false, failureClass: classifyEmailFailure(outcome.errorCode), errorCode: outcome.errorCode };
  }
}

const REASON_TEXT: Record<string, string> = {
  smtp_not_configured: 'el cliente no tiene el SMTP configurado',
  config_unavailable: 'no se pudo leer la configuración del correo (BD)',
  smtp_unavailable: 'servidor de correo no disponible, tiempo agotado o credenciales rechazadas',
  smtp_rejected: 'el servidor rechaza al destinatario (dirección incorrecta)',
  otro: 'otro error de envío',
};

/**
 * UN aviso al operador por pasada y día con TODO lo que no se ha podido enviar (en vez de uno crítico por pedido: SMTP sin configurar, una caída larga o
 * las erratas de email lo inundarían). Sin datos personales: solo recuentos y motivos agrupados; el detalle por pedido queda en el log. `dedupeKey` lleva
 * el cliente y el día, así que aunque otra pasada lo repita ese día no vuelve a salir.
 */
export async function alertEmailProblems(summary: { exhausted: number; systemic: number; reasons: Record<string, number>; kind: EmailKind }): Promise<void> {
  const tenant = currentTenant()?.tenantId ?? 'unico';
  const day = new Date().toISOString().slice(0, 10);
  const list = Object.entries(summary.reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `<li>${n} × ${esc(REASON_TEXT[code] ?? REASON_TEXT.otro)}</li>`)
    .join('');
  await alertOperator({
    kind: summary.kind,
    tag: TAG,
    orderId: 'aggregate',
    reason: 'email_failed',
    details: { exhausted: summary.exhausted, systemic: summary.systemic, reasons: summary.reasons },
    dedupeKey: `email-failed-agg:${tenant}:${day}`,
    subject: `⚠️ Hay emails de pedidos que no se pueden enviar (${summary.exhausted} agotados, ${summary.systemic} con fallo del servidor de correo)`,
    html:
      `<p>En la última pasada, ${summary.exhausted} pedido(s) han agotado los intentos de envío del email y ${summary.systemic} han fallado por un problema del servidor de correo (se reintentarán solos).</p>` +
      `<ul>${list}</ul>` +
      `<p>Revisa la configuración del correo (SMTP) en Configuración. Los pedidos agotados no se reintentan solos: cuando funcione, pulsa «Reenviar email» en el detalle del pedido del admin (el comprador puede además descargar lo comprado desde su pantalla de confirmación).</p>`,
  });
}

const withTimeout = <T,>(p: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]).finally(() => timer && clearTimeout(timer));
};

/**
 * Ejecuta `task` DESPUÉS de responder cuando hay una petición en curso (`after` de Next: la pasarela recibe su 200 sin esperar al PDF ni al SMTP)
 * y en el acto cuando no la hay (cron, scripts, pruebas). El contexto del cliente viaja con la tarea: en modo plataforma, sin él `prisma` no
 * sabría a qué BD ir. Si la función se corta antes de acabar, no se pierde nada: el barrido del cron lo recupera.
 */
export async function runAfterResponse(task: () => Promise<unknown>): Promise<'deferred' | 'inline'> {
  const tenant = currentTenant();
  const run = async () => {
    try {
      await (tenant ? runWithTenant(tenant, task) : task());
    } catch (error) {
      console.error(`${TAG} Error en una tarea posterior a la respuesta:`, error instanceof Error ? error.message : error);
    }
  };
  try {
    after(run);
    return 'deferred';
  } catch {
    // Fuera del ámbito de una petición `after` lanza: se ejecuta aquí mismo.
    await run();
    return 'inline';
  }
}

/** Envío automático del email de un pedido recién pagado, fuera de la ruta crítica (`runAfterResponse`). */
export async function scheduleOrderEmail(kind: EmailKind, id: string, opts: { baseUrl?: string; inline?: boolean } = {}): Promise<SendOrderEmailResult | 'deferred'> {
  if (opts.inline) return sendOrderEmail(kind, id, { baseUrl: opts.baseUrl, mode: 'auto' });
  let result: SendOrderEmailResult | null = null;
  const where = await runAfterResponse(async () => {
    result = await sendOrderEmail(kind, id, { baseUrl: opts.baseUrl, mode: 'auto' });
  });
  return where === 'inline' && result ? result : 'deferred';
}

export interface EmailSweepResult {
  examined: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Pedidos que han agotado los intentos en esta pasada. */
  exhausted: number;
  /** Fallos del servidor de correo (no agotan el pedido: se reintentan con backoff). */
  systemic: number;
  /** Candidatos que no cupieron en el presupuesto de tiempo o en el tope de la pasada: siguen para la siguiente. */
  deferred: number;
}

/** Tope de pedidos que atiende UNA pasada del cron (los PDF y el SMTP son lo más caro de la función y el panel espera la respuesta). */
export const EMAIL_SWEEP_BATCH = 5;
const envMs = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** Presupuesto PROPIO del barrido (ms): el cron de reconciliación confirma cobros y no puede esperar a un SMTP lento. (`EMAIL_SWEEP_BUDGET_MS` solo existe para probarlo.) */
export const emailSweepBudgetMs = () => envMs('EMAIL_SWEEP_BUDGET_MS', 12_000);
/** Tope duro por envío dentro del barrido (ms). (`EMAIL_SEND_CAP_MS` solo existe para probarlo.) */
export const emailSendCapMs = () => envMs('EMAIL_SEND_CAP_MS', 15_000);

/**
 * Barrido de reintentos: reenvía los pedidos pagados cuyo email no se confirmó (pasado el backoff y con intentos pendientes). Lo llama el cron
 * de reconciliación DESPUÉS de reconciliar pagos, con SU presupuesto de tiempo (`deadline`, que el cron acorta a EMAIL_SWEEP_BUDGET_MS) y SU tope de
 * concurrencia (`concurrency`). El plazo se mira ENTRE emails (un grupo de envíos lentos no lo rebasa) y cada envío tiene un tope duro. El lote reparte el
 * tope por igual entre entradas y tienda (antes, con 15 de entradas la tienda no se atendía nunca). Cada pedido se reclama de nuevo al enviarlo, así que dos
 * barridos solapados no duplican. El aviso al operador sale APARTE (tras la respuesta si hay petición) y nunca bloquea el lote.
 */
export async function sweepUnsentOrderEmails(params: { deadline: number; concurrency: number; baseUrl?: string; limit?: number; now?: number; sendCapMs?: number }): Promise<EmailSweepResult> {
  const limit = params.limit ?? EMAIL_SWEEP_BATCH;
  const out: EmailSweepResult = { examined: 0, sent: 0, failed: 0, skipped: 0, exhausted: 0, systemic: 0, deferred: 0 };
  const lists: { kind: EmailKind; id: string }[][] = [];
  for (const kind of ['entradas', 'tienda'] as const) {
    try {
      const rows = await listUnsent(kind, { limit: limit + 1, now: params.now });
      lists.push(rows.map((r) => ({ kind, id: r.id })));
    } catch (error) {
      console.error(`${TAG} No se pudo listar los emails sin enviar de ${kind}:`, error instanceof Error ? error.message : error);
    }
  }
  // Reparto alterno (round-robin): ningún tipo se queda sin turno por tener más candidatos.
  const batch: { kind: EmailKind; id: string }[] = [];
  for (let i = 0; batch.length < limit; i++) {
    let added = false;
    for (const list of lists) {
      if (list[i] && batch.length < limit) {
        batch.push(list[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  const total = lists.reduce((n, l) => n + l.length, 0);
  out.deferred = Math.max(0, total - batch.length);

  const reasons: Record<string, number> = {};
  let alertKind: EmailKind | null = null;
  let next = 0;
  // Un «pool» de `concurrency` trabajadores que comprueban el plazo ANTES DE CADA email (no solo entre grupos).
  const worker = async () => {
    for (;;) {
      if (Date.now() >= params.deadline) return;
      const i = next++;
      if (i >= batch.length) return;
      const c = batch[i];
      const capMs = params.sendCapMs ?? Math.min(emailSendCapMs(), Math.max(1_000, params.deadline - Date.now() + 3_000));
      const r = await sendOrderEmail(c.kind, c.id, { baseUrl: params.baseUrl, mode: 'auto', capMs });
      out.examined += 1;
      if (r.status === 'sent') out.sent += 1;
      else if (r.status === 'failed') {
        out.failed += 1;
        if (r.exhausted) out.exhausted += 1;
        if (r.failureClass === 'systemic') out.systemic += 1;
        if (r.exhausted || r.failureClass === 'systemic') {
          const code = r.errorCode && r.errorCode in REASON_TEXT ? r.errorCode : 'otro';
          reasons[code] = (reasons[code] ?? 0) + 1;
          alertKind ??= c.kind;
        }
      } else out.skipped += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(params.concurrency, batch.length)) }, worker));
  out.deferred += batch.length - Math.min(next, batch.length); // los que no llegaron a empezar por falta de tiempo

  if (alertKind) {
    // Aparte y sin bloquear: tras la respuesta si hay petición (el cron); sin ella (pruebas), con su propio tope de 4 s. Un SMTP colgado no retiene el lote.
    const summary = { exhausted: out.exhausted, systemic: out.systemic, reasons, kind: alertKind };
    await runAfterResponse(() => withTimeout(alertEmailProblems(summary), 4_000));
  }
  return out;
}

/** Lo que ve el ADMIN del email de un pedido: estado, intentos, último error (corto, sin datos personales) y cuándo toca el siguiente reintento. */
export interface AdminEmailView {
  status: EmailState['status'];
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  nextAttemptAt: Date | null;
}

export const adminEmailView = (state: EmailState | null | undefined): AdminEmailView | null =>
  state ? { status: state.status, attempts: state.attempts, lastError: state.lastError, sentAt: state.sentAt, nextAttemptAt: state.nextAttemptAt } : null;

/** Cómo se lo cuenta la pantalla del comprador: sin detalles técnicos ni del error. */
/** `unknown`: pedido sin rastro del email (tienda, anterior al seguimiento): la pantalla no dice nada del email. */
export type BuyerEmailView = 'sent' | 'sending' | 'retrying' | 'failed' | 'unknown';

export function buyerEmailView(state: (Pick<EmailState, 'status'> & { touchedAt?: Date | null }) | null, now: number = Date.now()): BuyerEmailView {
  if (!state) return 'unknown';
  // Un pedido pagado del que nadie ha intentado nada ni hay un envío en curso (el `after` se cortó y el barrido aún no ha pasado): pasado un rato deja de decir «enviándose».
  if (state.status === 'pending' && state.touchedAt && now - state.touchedAt.getTime() > EMAIL_PENDING_STALE_MS) return 'retrying';
  switch (state.status) {
    case 'sent':
      return 'sent';
    case 'exhausted':
      return 'failed';
    case 'retrying':
      return 'retrying';
    case 'unknown':
      return 'unknown';
    default:
      return 'sending'; // pending o sending (o pedido sin estado conocido)
  }
}

/** Reenvíos a petición del comprador por pedido y hora (además del límite por IP de cada ruta): «Reenviar a mi email» no es un cañón de correo. */
export const BUYER_RESEND_PER_HOUR = 3;

export function buyerResendLimit(kind: EmailKind, orderId: string) {
  return rateLimit(`email-resend-${kind}`, orderId, BUYER_RESEND_PER_HOUR, 60 * 60_000);
}

/** Respuesta HTTP de los botones «reenviar» (comprador y admin) a partir del resultado del envío. El comprador nunca ve el texto del error. */
export function sendResultResponse(result: SendOrderEmailResult, opts: { detail?: boolean } = {}): { httpStatus: number; body: { success: boolean; status: string; error?: string; alreadySent?: boolean } } {
  switch (result.status) {
    case 'error':
      // No se ha podido ni reclamar el envío: error honesto y reintentable (no «te lo estamos enviando»).
      return { httpStatus: 503, body: { success: false, status: 'error', error: 'No hemos podido procesarlo ahora mismo. Inténtalo de nuevo en un momento.' } };
    case 'sent':
      return { httpStatus: 200, body: { success: true, status: 'sent' } };
    case 'failed':
      return { httpStatus: 200, body: { success: false, status: 'failed', error: opts.detail ? result.error : 'No hemos podido enviarlo ahora mismo.' } };
    case 'skipped':
      switch (result.reason) {
        case 'already_sent':
          return { httpStatus: 200, body: { success: true, status: 'sent', alreadySent: true } };
        case 'in_progress':
          return { httpStatus: 200, body: { success: true, status: 'sending' } };
        case 'backoff':
          return { httpStatus: 200, body: { success: true, status: 'retrying' } };
        case 'exhausted':
          return { httpStatus: 200, body: { success: false, status: 'failed', error: 'order_email_exhausted' } };
        case 'not_found':
          return { httpStatus: 404, body: { success: false, status: 'not_found', error: 'Pedido no encontrado' } };
        default:
          return { httpStatus: 200, body: { success: false, status: 'not_sendable', error: 'order_inactive' } };
      }
  }
}
