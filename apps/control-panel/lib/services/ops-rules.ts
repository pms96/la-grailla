import type { OpsBlock } from '@grailla/contracts';

/* Reglas de alerta de NEGOCIO sobre el bloque `ops` de la salud de cada cliente (P0-07; umbrales de la auditoría de lanzamiento §4). Funciones puras.
 *
 * Solo se aplican si el front manda `ops`: un front anterior sin el bloque no genera ninguna señal (ni falsas alarmas). Las señales viajan en
 * el campo `error` de `TenantHealth` como líneas «Operación: …» (el panel ya lo muestra en la ficha y en Salud) y ESAS MISMAS LÍNEAS son la memoria
 * del estado anterior: así se avisa solo en el CAMBIO (aparece una señal, escala, o todo vuelve a la normalidad) con el mecanismo que ya existe, sin
 * tabla ni columna nuevas. Cada señal se reconoce por una frase fija (`needle`): si se cambia el texto, hay que cambiarla aquí también (hay test). */

/** Pedido pendiente de pago por encima de esto: de «aviso» a «fallo» (la pasarela o el reconcile no lo resuelven solos). */
export const PENDING_CRITICAL_MIN = 30;
/** El reconcile corre cada 5 min; si la última pasada es más vieja que esto, no está corriendo. */
export const RECONCILE_STALE_MIN = 15;
/** Emails sin enviar: se avisa si la señal se mantiene al menos este tiempo (dos comprobaciones seguidas), no por un tropiezo suelto. */
export const EMAILS_SUSTAINED_MS = 10 * 60_000;
/** La conciliación diaria con la pasarela corre cada 24 h; si la última pasada es más vieja que esto, no está corriendo (margen de un día perdido + reintentos). */
export const GATEWAY_STALE_H = 36;

export type OpsKey = 'pending' | 'pending_critical' | 'emails_unsent' | 'emails_failed' | 'reconcile_errors' | 'reconcile_stale' | 'gateway_unmatched' | 'gateway_check';
export type OpsSeverity = 'warning' | 'critical';
export type OpsFinding = { key: OpsKey; severity: OpsSeverity; /** Título corto del aviso. */ title: string; /** Línea que se guarda y se muestra. */ line: string };

/** Prefijo de las líneas de operación dentro de `TenantHealth.error` (separadas por ` · `). */
export const OPS_PREFIX = 'Operación: ';
const SEP = ' · ';

/** Frase fija con la que se reconoce cada señal en la línea guardada. */
const NEEDLE: Record<OpsKey, string> = {
  pending: 'pendientes de pago con más de 20 min',
  pending_critical: 'pendientes de pago sin resolver tras más de 30 min',
  emails_unsent: 'emails de confirmación sin enviar',
  emails_failed: 'emails de confirmación con error de envío',
  reconcile_errors: 'el reconcile tiene errores',
  reconcile_stale: 'el reconcile no corre',
  gateway_unmatched: 'cobros en la pasarela sin pedido confirmado',
  gateway_check: 'la conciliación diaria con la pasarela no está al día',
};
const SUSTAINED_MARK = '(sostenido)';
/** Marca de una línea que se guardó pero cuyo aviso NO llegó a salir (tope de avisos por pasada o canal caído): en la siguiente pasada se vuelve a avisar. */
export const PENDING_MARK = ' [aviso pendiente]';

export type OpsEvaluation = {
  /** Señales activas ahora (todas, no solo las nuevas). */
  findings: OpsFinding[];
  /** Señales que hay que avisar AHORA (nuevas o escaladas). */
  raise: OpsFinding[];
  /** Había señales avisadas y ya no queda ninguna. */
  recovered: boolean;
};

/** Parte el texto de `TenantHealth.error` en líneas de operación y el resto (esquema, onboarding, deriva…). */
export function splitHealthError(error: string | null | undefined): { ops: string[]; other: string[] } {
  const parts = (error ?? '').split(SEP).map((p) => p.trim()).filter(Boolean);
  return { ops: parts.filter((p) => p.startsWith(OPS_PREFIX)), other: parts.filter((p) => !p.startsWith(OPS_PREFIX)) };
}

/** ¿Alguna de las líneas de operación guardadas es de gravedad «fallo»? (la ficha y Salud pintan en rojo en lugar de en ámbar) */
export function hasCriticalOps(error: string | null | undefined): boolean {
  const critical: OpsKey[] = ['pending_critical', 'emails_failed', 'reconcile_errors', 'reconcile_stale', 'gateway_unmatched'];
  return splitHealthError(error).ops.some((line) => critical.some((k) => line.includes(NEEDLE[k])));
}

type Previous = Map<OpsKey, { line: string; /** La línea consta pero su aviso no salió. */ unalerted: boolean }>;
function previousFindings(error: string | null | undefined): Previous {
  const out: Previous = new Map();
  for (const line of splitHealthError(error).ops) {
    for (const key of Object.keys(NEEDLE) as OpsKey[]) if (line.includes(NEEDLE[key])) out.set(key, { line, unalerted: line.endsWith(PENDING_MARK) });
  }
  return out;
}

/** Marca como «aviso pendiente» las líneas de esas señales: el aviso no salió (tope por pasada o canal caído) y no puede darse por hecho. */
export function markUnalerted(error: string | null | undefined, keys: OpsKey[]): string | null {
  if (!error) return error ?? null;
  return error
    .split(SEP)
    .map((part) => (part.trim().startsWith(OPS_PREFIX) && !part.endsWith(PENDING_MARK) && keys.some((k) => part.includes(NEEDLE[k])) ? `${part.trim()}${PENDING_MARK}` : part))
    .join(SEP);
}

const minutes = (n: number) => Math.round(n);

/** Gravedad y título de cada señal, para poder CONSERVARLA tal cual cuando el front no pudo medirla en esta pasada. */
const META: Record<OpsKey, { severity: OpsSeverity; title: string }> = {
  pending: { severity: 'warning', title: 'pedidos pendientes de pago' },
  pending_critical: { severity: 'critical', title: 'pedidos pendientes de pago sin resolver (más de 30 min)' },
  emails_unsent: { severity: 'warning', title: 'emails sin enviar' },
  emails_failed: { severity: 'critical', title: 'emails con error de envío' },
  reconcile_errors: { severity: 'critical', title: 'el reconcile tiene errores' },
  reconcile_stale: { severity: 'critical', title: 'el reconcile no corre' },
  gateway_unmatched: { severity: 'critical', title: 'cobros sin pedido confirmado' },
  gateway_check: { severity: 'warning', title: 'conciliación con la pasarela sin hacer' },
};
const SINCE_RE = /desde (\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z/;
/** Primera vez que se vio la señal de emails (a precisión de minuto), de la línea anterior; si no había, ahora. */
function emailsSince(previousLine: string | undefined, now: number): number {
  const m = previousLine ? SINCE_RE.exec(previousLine) : null;
  const parsed = m ? Date.parse(`${m[1]}:00Z`) : NaN;
  return Number.isFinite(parsed) && parsed <= now ? parsed : now;
}

/**
 * Evalúa el bloque `ops` y decide qué avisar. `previousError` es el `error` guardado en la comprobación anterior (null si no había).
 * `now` en ms. No lanza.
 */
export function evaluateOps(ops: OpsBlock, now: number, previousError: string | null | undefined): OpsEvaluation {
  const prev = previousFindings(previousError);
  const findings: OpsFinding[] = [];

  // 1. Pedidos pendientes de pago: > 20 min = aviso; el más antiguo > 30 min = fallo (y es lo único que se muestra: no se duplica la línea).
  // Un contador NULO es «no se pudo medir» (falló la consulta del front), no «no hay nada»: se conserva lo que ya constaba en lugar de dar
  // por resuelto un problema que quizá sigue ahí (un falso «recuperado»).
  const carry = (...keys: OpsKey[]) => {
    for (const key of keys) {
      const before = prev.get(key);
      if (before) findings.push({ key, ...META[key], line: before.line });
    }
  };
  const oldest = ops.pendingOldestMinutes;
  const oldestTxt = oldest === null ? '' : `, el más antiguo lleva ${minutes(oldest)} min`;
  if (ops.pendingOver20min === null) {
    carry('pending', 'pending_critical');
  } else if (oldest !== null && oldest > PENDING_CRITICAL_MIN) {
    findings.push({
      key: 'pending_critical',
      severity: 'critical',
      title: 'pedidos pendientes de pago sin resolver (más de 30 min)',
      line: `${OPS_PREFIX}pedidos ${NEEDLE.pending_critical} — ${minutes(ops.pendingOver20min)} con más de 20 min${oldestTxt}`,
    });
  } else if (ops.pendingOver20min > 0) {
    findings.push({
      key: 'pending',
      severity: 'warning',
      title: 'pedidos pendientes de pago',
      line: `${OPS_PREFIX}pedidos ${NEEDLE.pending} — ${minutes(ops.pendingOver20min)} en total${oldestTxt}`,
    });
  }

  // 2. Emails de confirmación sin enviar: solo si se mantiene (la línea recuerda desde cuándo y marca «(sostenido)»).
  let emailsSustainedNow = false;
  if (ops.emailsUnsent === null) {
    carry('emails_unsent');
  } else if (ops.emailsUnsent > 0) {
    const since = emailsSince(prev.get('emails_unsent')?.line, now);
    emailsSustainedNow = now - since >= EMAILS_SUSTAINED_MS;
    findings.push({
      key: 'emails_unsent',
      severity: 'warning',
      title: 'emails sin enviar',
      line: `${OPS_PREFIX}${NEEDLE.emails_unsent} — ${minutes(ops.emailsUnsent)}, desde ${new Date(since).toISOString().slice(0, 16)}Z${emailsSustainedNow ? ` ${SUSTAINED_MARK}` : ''}`,
    });
  }

  // 3. Emails con error de envío.
  if (ops.emailsFailed === null) {
    carry('emails_failed');
  } else if (ops.emailsFailed > 0) {
    findings.push({ key: 'emails_failed', severity: 'critical', title: 'emails con error de envío', line: `${OPS_PREFIX}${NEEDLE.emails_failed} — ${minutes(ops.emailsFailed)}` });
  }

  // 4. Reconcile: errores, pedidos sin poder consultar o atascados más de 24 h; y que no corra.
  const rc = ops.reconcile;
  if (rc) {
    if (rc.errors > 0 || rc.unknown > 0 || rc.stuckOver24h > 0) {
      findings.push({
        key: 'reconcile_errors',
        severity: 'critical',
        title: 'el reconcile tiene errores',
        line: `${OPS_PREFIX}${NEEDLE.reconcile_errors} — ${minutes(rc.errors)} con error, ${minutes(rc.unknown)} sin poder consultar la pasarela, ${minutes(rc.stuckOver24h)} atascados más de 24 h`,
      });
    }
    const last = rc.lastRunAt ? Date.parse(rc.lastRunAt) : NaN;
    // Sin ninguna pasada registrada (null) no se avisa: lo cubre la tarea `reconcile-payments` del propio panel (fallos seguidos).
    if (Number.isFinite(last) && now - last > RECONCILE_STALE_MIN * 60_000) {
      findings.push({
        key: 'reconcile_stale',
        severity: 'critical',
        title: 'el reconcile no corre',
        line: `${OPS_PREFIX}${NEEDLE.reconcile_stale} — la última pasada fue hace ${minutes((now - last) / 60_000)} min`,
      });
    }
  }

  // 5. Conciliación diaria con la pasarela (alerta nº 1 de la auditoría). `undefined` (un front anterior que no la hace) y `null` (aún no ha corrido, o el front
  // no pudo leerla en esta pasada: no se distingue) NO aplican ninguna regla y CONSERVAN lo que ya constaba: un tropiezo de lectura no puede dar por resuelto
  // un cobro sin pedido. Sin línea previa no hay nada que conservar (la tarea `reconcile-gateway` del propio panel cubre sus fallos seguidos).
  const gw = ops.gateway;
  if (gw) {
    if (gw.unmatched > 0) {
      findings.push({
        key: 'gateway_unmatched',
        severity: 'critical',
        title: 'cobros sin pedido confirmado',
        line: `${OPS_PREFIX}${NEEDLE.gateway_unmatched} — ${minutes(gw.unmatched)} en las últimas 48 h`,
      });
    }
    const lastGw = Date.parse(gw.lastRunAt);
    const ageH = Number.isFinite(lastGw) ? (now - lastGw) / 3_600_000 : 0;
    // Una pasada que no pudo mirar alguna cuenta NO demuestra que ya no haya cobros sin pedido: se conserva el aviso anterior en vez de darlo por resuelto.
    if (gw.errors > 0 && gw.unmatched === 0) carry('gateway_unmatched');
    if (gw.errors > 0 || gw.truncated || ageH > GATEWAY_STALE_H) {
      const why = [
        gw.errors > 0 ? `${minutes(gw.errors)} cuenta(s) de cobro sin poder consultar` : '',
        gw.truncated ? 'la lista de cobros se cortó (puede haber cobros sin mirar)' : '',
        ageH > GATEWAY_STALE_H ? `la última pasada fue hace ${minutes(ageH)} h` : '',
      ].filter(Boolean).join(', ');
      findings.push({ key: 'gateway_check', severity: 'warning', title: 'conciliación con la pasarela sin hacer', line: `${OPS_PREFIX}${NEEDLE.gateway_check} — ${why}` });
    }
  } else {
    carry('gateway_unmatched', 'gateway_check');
  }

  // Qué avisar: lo que antes no estaba (o escala de aviso a fallo: es otra clave); los emails, cuando pasan a «sostenido».
  const raise = findings.filter((f) => {
    const before = prev.get(f.key);
    if (f.key === 'emails_unsent') return emailsSustainedNow && (!before || before.unalerted || !before.line.includes(SUSTAINED_MARK));
    return !before || before.unalerted; // nueva, o constaba pero su aviso no llegó a salir
  });
  // «Recuperado» solo si lo que había se llegó a avisar (unos emails que aún no eran «sostenidos» no avisaron, así que tampoco avisa su fin; ni
  // una señal cuyo aviso quedó pendiente).
  const hadAlerted = [...prev.entries()].some(([k, v]) => !v.unalerted && (k !== 'emails_unsent' || v.line.includes(SUSTAINED_MARK)));
  return { findings, raise, recovered: findings.length === 0 && hadAlerted };
}

/** Un único aviso por cliente y pasada con lo nuevo: un fallo manda sobre un aviso, y varios se resumen en un título. */
export function opsAlertFor(raise: OpsFinding[]): { severity: OpsSeverity; title: string; detail: string } | null {
  if (raise.length === 0) return null;
  return {
    severity: raise.some((f) => f.severity === 'critical') ? 'critical' : 'warning',
    title: raise.length === 1 ? raise[0].title : `${raise.length} señales de operación`,
    detail: raise.map((f) => f.line.slice(OPS_PREFIX.length)).join(' | '),
  };
}
