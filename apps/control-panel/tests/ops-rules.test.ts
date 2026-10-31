import { describe, expect, it } from 'vitest';
import type { OpsBlock } from '@grailla/contracts';
import {
  EMAILS_SUSTAINED_MS,
  OPS_PREFIX,
  PENDING_CRITICAL_MIN,
  RECONCILE_STALE_MIN,
  evaluateOps,
  PENDING_MARK,
  hasCriticalOps,
  markUnalerted,
  opsAlertFor,
  splitHealthError,
} from '@/lib/services/ops-rules';
import { assessSubscription } from '@/lib/queries';

/* Reglas de alerta de negocio sobre `ops` (umbrales de la auditoría de lanzamiento §4). Puras: sin BD. */

const NOW = Date.parse('2026-10-27T10:00:00.000Z');
const MIN = 60_000;
const minutesAgo = (m: number) => new Date(NOW - m * MIN).toISOString();

const calm = (over: Partial<OpsBlock> = {}): OpsBlock => ({
  generatedAt: new Date(NOW).toISOString(),
  pendingOldestMinutes: null,
  pendingOver20min: 0,
  emailsUnsent: 0,
  emailsFailed: 0,
  reconcile: { lastRunAt: minutesAgo(3), errors: 0, unknown: 0, processing: 0, stuckOver24h: 0 },
  ...over,
});
/** Un bloque tranquilo calculado `at` ms después de NOW (con la última pasada del reconcile al día en ese momento). */
const calmAt = (at: number, over: Partial<OpsBlock> = {}) => calm({ reconcile: { lastRunAt: new Date(NOW + at - 3 * MIN).toISOString(), errors: 0, unknown: 0, processing: 0, stuckOver24h: 0 }, ...over });
const keys = (e: ReturnType<typeof evaluateOps>) => e.findings.map((f) => f.key);

describe('sin señales', () => {
  it('un bloque tranquilo no genera nada (ni avisos ni recuperación)', () => {
    const e = evaluateOps(calm(), NOW, null);
    expect(e).toEqual({ findings: [], raise: [], recovered: false });
  });

  it('los cobros en curso (`processing`) y un pedido pendiente de pocos minutos no son una señal', () => {
    const e = evaluateOps(calm({ pendingOldestMinutes: 12, reconcile: { lastRunAt: minutesAgo(1), errors: 0, unknown: 0, processing: 4, stuckOver24h: 0 } }), NOW, null);
    expect(e.findings).toEqual([]);
  });

  it('reconcile null (aún sin pasadas registradas) no activa las reglas del reconcile', () => {
    expect(evaluateOps(calm({ reconcile: null }), NOW, null).findings).toEqual([]);
    expect(evaluateOps(calm({ reconcile: { lastRunAt: null, errors: 0, unknown: 0, processing: 0, stuckOver24h: 0 } }), NOW, null).findings).toEqual([]);
  });
});

describe('pedidos pendientes de pago', () => {
  it('pendingOver20min > 0 es un AVISO «pedidos pendientes de pago»', () => {
    const e = evaluateOps(calm({ pendingOver20min: 2, pendingOldestMinutes: 25 }), NOW, null);
    expect(keys(e)).toEqual(['pending']);
    expect(e.findings[0]).toMatchObject({ severity: 'warning', title: 'pedidos pendientes de pago' });
    expect(e.findings[0].line).toContain('2 en total');
    expect(e.findings[0].line).toContain('25 min');
    expect(e.raise).toHaveLength(1);
  });

  it(`el más antiguo con más de ${PENDING_CRITICAL_MIN} min pasa a FALLO (y solo se muestra esa línea)`, () => {
    const e = evaluateOps(calm({ pendingOver20min: 1, pendingOldestMinutes: PENDING_CRITICAL_MIN + 1 }), NOW, null);
    expect(keys(e)).toEqual(['pending_critical']);
    expect(e.findings[0].severity).toBe('critical');
  });

  it('justo en el umbral (30 min) todavía es aviso', () => {
    expect(keys(evaluateOps(calm({ pendingOver20min: 1, pendingOldestMinutes: PENDING_CRITICAL_MIN }), NOW, null))).toEqual(['pending']);
  });

  it('oldest > 60 aunque el contador de fuera de plazo venga a 0 (producer inconsistente) también se avisa', () => {
    expect(keys(evaluateOps(calm({ pendingOver20min: 0, pendingOldestMinutes: 75 }), NOW, null))).toEqual(['pending_critical']);
  });

  it('un contador >20 min sin edad conocida se avisa igualmente', () => {
    const e = evaluateOps(calm({ pendingOver20min: 3, pendingOldestMinutes: null }), NOW, null);
    expect(keys(e)).toEqual(['pending']);
    expect(e.findings[0].line).not.toContain('el más antiguo');
  });
});

describe('emails', () => {
  it('emailsUnsent > 0 solo avisa si se SOSTIENE (no por un tropiezo suelto) y deja constancia de desde cuándo', () => {
    const first = evaluateOps(calm({ emailsUnsent: 3 }), NOW, null);
    expect(keys(first)).toEqual(['emails_unsent']);
    expect(first.raise).toEqual([]);
    expect(first.findings[0].line).toContain('desde 2026-10-27T10:00Z');
    expect(first.findings[0].line).not.toContain('(sostenido)');

    // 5 min después sigue sin llegar el aviso (todavía no hay 10 min)
    const second = evaluateOps(calmAt(5 * MIN, { emailsUnsent: 3 }), NOW + 5 * MIN, first.findings[0].line);
    expect(second.raise).toEqual([]);

    // a los 10 min pasa a «sostenido» y AHORA sí avisa, una sola vez
    const third = evaluateOps(calmAt(EMAILS_SUSTAINED_MS, { emailsUnsent: 4 }), NOW + EMAILS_SUSTAINED_MS, second.findings[0].line);
    expect(third.findings[0].line).toContain('(sostenido)');
    expect(third.findings[0].line).toContain('desde 2026-10-27T10:00Z');
    expect(third.raise.map((f) => f.key)).toEqual(['emails_unsent']);
    expect(third.raise[0]).toMatchObject({ severity: 'warning', title: 'emails sin enviar' });

    const fourth = evaluateOps(calmAt(15 * MIN, { emailsUnsent: 4 }), NOW + 15 * MIN, third.findings[0].line);
    expect(fourth.raise).toEqual([]);
  });

  it('si los emails desaparecen antes de ser «sostenidos», no hay aviso ni «recuperado»', () => {
    const first = evaluateOps(calm({ emailsUnsent: 1 }), NOW, null);
    const gone = evaluateOps(calmAt(5 * MIN), NOW + 5 * MIN, first.findings[0].line);
    expect(gone).toEqual({ findings: [], raise: [], recovered: false });
  });

  it('si desaparecen tras avisar, sí hay «recuperado»', () => {
    const sustained = evaluateOps(calmAt(10 * MIN, { emailsUnsent: 1 }), NOW + 10 * MIN, `${OPS_PREFIX}emails de confirmación sin enviar — 1, desde 2026-10-27T10:00Z (sostenido)`);
    expect(sustained.raise).toEqual([]); // ya constaba como sostenido: no repite
    const gone = evaluateOps(calmAt(15 * MIN), NOW + 15 * MIN, sustained.findings[0].line);
    expect(gone.recovered).toBe(true);
  });

  it('emailsFailed > 0 es un FALLO inmediato', () => {
    const e = evaluateOps(calm({ emailsFailed: 2 }), NOW, null);
    expect(e.raise).toHaveLength(1);
    expect(e.raise[0]).toMatchObject({ key: 'emails_failed', severity: 'critical' });
  });
});

describe('reconcile', () => {
  const rc = (over: Partial<NonNullable<OpsBlock['reconcile']>>) => calm({ reconcile: { lastRunAt: minutesAgo(2), errors: 0, unknown: 0, processing: 0, stuckOver24h: 0, ...over } });

  it.each([
    ['errors', { errors: 1 }],
    ['unknown', { unknown: 2 }],
    ['stuckOver24h', { stuckOver24h: 1 }],
  ])('%s > 0 es un FALLO «el reconcile tiene errores»', (_n, over) => {
    const e = evaluateOps(rc(over), NOW, null);
    expect(keys(e)).toEqual(['reconcile_errors']);
    expect(e.findings[0].severity).toBe('critical');
  });

  it(`una última pasada de hace más de ${RECONCILE_STALE_MIN} min es «el reconcile no corre»`, () => {
    expect(keys(evaluateOps(rc({ lastRunAt: minutesAgo(RECONCILE_STALE_MIN) }), NOW, null))).toEqual([]); // justo en el umbral, no
    const e = evaluateOps(rc({ lastRunAt: minutesAgo(RECONCILE_STALE_MIN + 7) }), NOW, null);
    expect(keys(e)).toEqual(['reconcile_stale']);
    expect(e.findings[0].line).toContain('hace 22 min');
  });

  it('se pueden dar a la vez (errores y parado)', () => {
    expect(keys(evaluateOps(rc({ errors: 3, lastRunAt: minutesAgo(40) }), NOW, null))).toEqual(['reconcile_errors', 'reconcile_stale']);
  });
});

describe('avisar solo en el CAMBIO', () => {
  it('una señal que ya estaba no se repite; una nueva sí; la escalada de aviso a fallo sí', () => {
    const a = evaluateOps(calm({ pendingOver20min: 1, pendingOldestMinutes: 46 }), NOW, null);
    expect(a.raise.map((f) => f.key)).toEqual(['pending']);
    const lines = (e: ReturnType<typeof evaluateOps>) => e.findings.map((f) => f.line).join(' · ');

    const same = evaluateOps(calmAt(5 * MIN, { pendingOver20min: 1, pendingOldestMinutes: 51 }), NOW + 5 * MIN, lines(a));
    expect(same.raise).toEqual([]); // el número cambia, la señal es la misma

    const plusErr = evaluateOps(calmAt(10 * MIN, { pendingOver20min: 1, pendingOldestMinutes: 61, emailsFailed: 1 }), NOW + 10 * MIN, lines(same));
    expect(plusErr.raise.map((f) => f.key).sort()).toEqual(['emails_failed', 'pending_critical']); // escalada + nueva
  });

  it('cuando todo vuelve a la normalidad hay UN «recuperado»; después, silencio', () => {
    const bad = evaluateOps(calm({ emailsFailed: 1 }), NOW, null);
    const ok = evaluateOps(calmAt(5 * MIN), NOW + 5 * MIN, bad.findings.map((f) => f.line).join(' · '));
    expect(ok).toMatchObject({ findings: [], raise: [], recovered: true });
    const after = evaluateOps(calmAt(10 * MIN), NOW + 10 * MIN, null);
    expect(after.recovered).toBe(false);
  });

  it('las líneas de operación conviven con los problemas técnicos en el mismo texto, y solo se reconocen las suyas', () => {
    const bad = evaluateOps(calm({ emailsFailed: 1 }), NOW, null);
    const error = ['Esquema atrasado: aplicado x', ...bad.findings.map((f) => f.line), 'Datos sin completar: legal_notice'].join(' · ');
    expect(splitHealthError(error)).toEqual({ ops: [bad.findings[0].line], other: ['Esquema atrasado: aplicado x', 'Datos sin completar: legal_notice'] });
    expect(evaluateOps(calmAt(5 * MIN, { emailsFailed: 1 }), NOW + 5 * MIN, error).raise).toEqual([]);
    expect(splitHealthError(null)).toEqual({ ops: [], other: [] });
  });
});

describe('opsAlertFor', () => {
  it('sin nada nuevo, no hay aviso', () => expect(opsAlertFor([])).toBeNull());

  it('una señal: su título; un fallo manda sobre un aviso; varias se resumen', () => {
    const w = evaluateOps(calm({ pendingOver20min: 1, pendingOldestMinutes: 21 }), NOW, null).raise;
    expect(opsAlertFor(w)).toMatchObject({ severity: 'warning', title: 'pedidos pendientes de pago' });
    const both = evaluateOps(calm({ pendingOver20min: 1, pendingOldestMinutes: 21, emailsFailed: 1 }), NOW, null).raise;
    const alert = opsAlertFor(both)!;
    expect(alert).toMatchObject({ severity: 'critical', title: '2 señales de operación' });
    expect(alert.detail).toContain('pedidos pendientes de pago');
    expect(alert.detail).toContain('con error de envío');
    expect(alert.detail).not.toContain(OPS_PREFIX);
  });

  it('el aviso solo lleva contadores y minutos: nada de datos personales', () => {
    const all = evaluateOps(calm({ pendingOver20min: 2, pendingOldestMinutes: 44, emailsFailed: 1, emailsUnsent: 1, reconcile: { lastRunAt: minutesAgo(30), errors: 1, unknown: 1, processing: 0, stuckOver24h: 1 } }), NOW + 20 * MIN, null);
    expect(opsAlertFor(all.findings)!.detail).not.toMatch(/@|https?:|\+34/);
  });
});

describe('en el panel (Salud y ficha)', () => {
  const NOW_MS = 1_800_000_000_000;
  const base = { published: true, publishedAt: new Date(NOW_MS - 3_600_000), crons: [], lastMigration: null };
  const health = (error: string) => ({ checkedAt: new Date(NOW_MS - 60_000), ok: false, status: 'degraded', error });

  it('cada señal es un problema aparte; los avisos pintan «atención» y los fallos «falla»', () => {
    const warn = assessSubscription({ ...base, health: health(`${OPS_PREFIX}pedidos pendientes de pago con más de 20 min — 1 en total · Datos sin completar: x`) }, NOW_MS);
    expect(warn.level).toBe('warn');
    expect(warn.problems).toHaveLength(2);
    const bad = assessSubscription({ ...base, health: health(`${OPS_PREFIX}emails de confirmación con error de envío — 1`) }, NOW_MS);
    expect(bad.level).toBe('bad');
    expect(hasCriticalOps(`${OPS_PREFIX}emails de confirmación con error de envío — 1`)).toBe(true);
    expect(hasCriticalOps(`${OPS_PREFIX}emails de confirmación sin enviar — 1, desde 2026-10-27T10:00Z`)).toBe(false);
    expect(hasCriticalOps(null)).toBe(false);
  });
});

describe('contadores que el front no pudo medir (null)', () => {
  // El front devuelve null cuando una consulta falla: es «no se sabe», no «no hay nada». Dar por resuelto un problema que quizá sigue ahí sería
  // un falso «recuperado»: la señal anterior se CONSERVA tal cual hasta que haya una medida válida.
  const previousOf = (over: Partial<OpsBlock>) => evaluateOps(calm(over), NOW, null).findings.map((f) => f.line).join(' · ');

  it('un `pendingOver20min` nulo conserva el aviso de pendientes anterior y no lo da por recuperado ni lo vuelve a avisar', () => {
    const before = previousOf({ pendingOver20min: 2, pendingOldestMinutes: 25 });
    const e = evaluateOps(calm({ pendingOver20min: null, pendingOldestMinutes: null }), NOW + 5 * MIN, before);
    expect(keys(e)).toEqual(['pending']);
    expect(e.raise).toEqual([]);
    expect(e.recovered).toBe(false);
  });

  it('conserva también el fallo crítico de pendientes (más de 60 min)', () => {
    const before = previousOf({ pendingOver20min: 3, pendingOldestMinutes: 75 });
    const e = evaluateOps(calm({ pendingOver20min: null }), NOW + 5 * MIN, before);
    expect(keys(e)).toEqual(['pending_critical']);
    expect(e.recovered).toBe(false);
  });

  it('un `emailsFailed` nulo conserva el fallo de emails; uno medido a 0 sí lo da por recuperado', () => {
    const before = previousOf({ emailsFailed: 4 });
    const unknown = evaluateOps(calm({ emailsFailed: null }), NOW + 5 * MIN, before);
    expect(keys(unknown)).toEqual(['emails_failed']);
    expect(unknown.raise).toEqual([]);
    expect(unknown.recovered).toBe(false);
    const fixed = evaluateOps(calm({ emailsFailed: 0 }), NOW + 10 * MIN, before);
    expect(fixed.findings).toEqual([]);
    expect(fixed.recovered).toBe(true);
  });

  it('un `emailsUnsent` nulo conserva la señal (con su marca de sostenido) sin reiniciar el contador de tiempo', () => {
    const t1 = evaluateOps(calm({ emailsUnsent: 3 }), NOW, null);
    const t2 = evaluateOps(calm({ emailsUnsent: 3 }), NOW + EMAILS_SUSTAINED_MS + MIN, t1.findings.map((f) => f.line).join(' · '));
    const stored = t2.findings.map((f) => f.line).join(' · ');
    const t3 = evaluateOps(calm({ emailsUnsent: null }), NOW + EMAILS_SUSTAINED_MS + 2 * MIN, stored);
    expect(keys(t3)).toEqual(['emails_unsent']);
    expect(t3.findings[0].line).toBe(t2.findings[0].line);
    expect(t3.raise).toEqual([]);
  });

  it('sin señal previa, un contador nulo no inventa ninguna ni avisa', () => {
    const e = evaluateOps(calm({ pendingOver20min: null, emailsUnsent: null, emailsFailed: null }), NOW, null);
    expect(e).toEqual({ findings: [], raise: [], recovered: false });
  });
});

describe('avisos que no salieron (M3)', () => {
  it('una línea marcada como pendiente se vuelve a avisar aunque la señal ya constara, y su marca no se arrastra', () => {
    const first = evaluateOps(calm({ emailsFailed: 1 }), NOW, null);
    expect(first.raise).toHaveLength(1);
    const stored = markUnalerted(first.findings.map((f) => f.line).join(' · '), ['emails_failed'])!;
    expect(stored.endsWith(PENDING_MARK)).toBe(true);
    const again = evaluateOps(calmAt(5 * MIN, { emailsFailed: 1 }), NOW + 5 * MIN, stored);
    expect(again.raise.map((f) => f.key)).toEqual(['emails_failed']);
    expect(again.findings[0].line.endsWith(PENDING_MARK)).toBe(false); // la línea nueva no hereda la marca
    const quiet = evaluateOps(calmAt(10 * MIN, { emailsFailed: 1 }), NOW + 10 * MIN, again.findings[0].line);
    expect(quiet.raise).toEqual([]);
  });

  it('markUnalerted solo toca las señales indicadas y es idempotente', () => {
    const e = evaluateOps(calm({ emailsFailed: 1, pendingOver20min: 1, pendingOldestMinutes: 25 }), NOW, null);
    const error = [...e.findings.map((f) => f.line), 'Datos sin completar: x'].join(' · ');
    const once = markUnalerted(error, ['emails_failed'])!;
    expect(once.match(/\[aviso pendiente\]/g)).toHaveLength(1);
    expect(once).toContain('Datos sin completar: x');
    expect(markUnalerted(once, ['emails_failed'])).toBe(once);
    expect(markUnalerted(null, ['emails_failed'])).toBeNull();
  });

  it('si desaparece una señal cuyo aviso nunca salió, no hay «recuperado» (nunca hubo aviso que cerrar)', () => {
    const e = evaluateOps(calm({ emailsFailed: 1 }), NOW, null);
    const stored = markUnalerted(e.findings.map((f) => f.line).join(' · '), ['emails_failed']);
    expect(evaluateOps(calmAt(5 * MIN), NOW + 5 * MIN, stored)).toMatchObject({ findings: [], recovered: false });
  });

  it('los emails sostenidos con aviso pendiente se avisan al volver a evaluarlos', () => {
    const line = `${OPS_PREFIX}emails de confirmación sin enviar — 1, desde 2026-10-27T10:00Z (sostenido)${PENDING_MARK}`;
    const e = evaluateOps(calmAt(10 * MIN, { emailsUnsent: 1 }), NOW + 10 * MIN, line);
    expect(e.raise.map((f) => f.key)).toEqual(['emails_unsent']);
  });
});

describe('Salud: un cliente caído muestra el motivo y, aparte, las señales de operación conservadas', () => {
  const NOW_MS = 1_800_000_000_000;
  it('no mezcla las líneas de operación dentro del «No responde»', () => {
    const r = assessSubscription(
      { published: true, publishedAt: new Date(NOW_MS - 3_600_000), crons: [], lastMigration: null, health: { checkedAt: new Date(NOW_MS - 60_000), ok: false, status: 'unreachable', error: `${OPS_PREFIX}emails de confirmación con error de envío — 2 · timeout` } },
      NOW_MS
    );
    expect(r.level).toBe('bad');
    expect(r.problems[0]).toBe('No responde: timeout');
    expect(r.problems[1]).toContain('con error de envío');
  });
});

describe('conciliación diaria con la pasarela (alerta nº 1: cobro sin pedido)', () => {
  const gw = (over: Partial<NonNullable<OpsBlock['gateway']>> = {}): NonNullable<OpsBlock['gateway']> => ({ lastRunAt: minutesAgo(60), checked: 12, unmatched: 0, errors: 0, skipped: 0, truncated: false, ...over });

  it('un front sin el campo (versión anterior) o que aún no ha corrido no genera nada', () => {
    expect(evaluateOps(calm(), NOW, null).findings).toEqual([]);
    expect(evaluateOps(calm({ gateway: null }), NOW, null).findings).toEqual([]);
  });

  it('todo cuadra y al día: sin señal', () => {
    expect(evaluateOps(calm({ gateway: gw() }), NOW, null).findings).toEqual([]);
  });

  it('cualquier cobro sin pedido es un FALLO que avisa de inmediato (umbral 0)', () => {
    const e = evaluateOps(calm({ gateway: gw({ unmatched: 1 }) }), NOW, null);
    expect(keys(e)).toEqual(['gateway_unmatched']);
    expect(e.findings[0].severity).toBe('critical');
    expect(e.raise.map((f) => f.key)).toEqual(['gateway_unmatched']);
    expect(e.findings[0].line).toContain('1 en las últimas 48 h');
    expect(opsAlertFor(e.raise)).toMatchObject({ severity: 'critical', title: 'cobros sin pedido confirmado' });
    expect(hasCriticalOps(e.findings[0].line)).toBe(true);
  });

  it('el mismo incidente en la pasada siguiente no vuelve a avisar; al resolverse avisa «recuperado»', () => {
    const first = evaluateOps(calm({ gateway: gw({ unmatched: 2 }) }), NOW, null);
    const line = first.findings.map((f) => f.line).join(' · ');
    const again = evaluateOps(calm({ gateway: gw({ unmatched: 2 }) }), NOW + 5 * MIN, line);
    expect(again.raise).toEqual([]);
    const solved = evaluateOps(calm({ gateway: gw({ unmatched: 0 }) }), NOW + 10 * MIN, line);
    expect(solved).toMatchObject({ findings: [], recovered: true });
  });

  it('cuentas de cobro sin poder consultar, o una conciliación vieja (>36 h), es un AVISO («no está al día»), no un fallo', () => {
    const errs = evaluateOps(calm({ gateway: gw({ errors: 1 }) }), NOW, null);
    expect(keys(errs)).toEqual(['gateway_check']);
    expect(errs.findings[0].severity).toBe('warning');
    expect(errs.findings[0].line).toContain('1 cuenta(s) de cobro sin poder consultar');
    const stale = evaluateOps(calm({ gateway: gw({ lastRunAt: minutesAgo(37 * 60) }) }), NOW, null);
    expect(keys(stale)).toEqual(['gateway_check']);
    expect(stale.findings[0].line).toContain('hace 37 h');
    expect(keys(evaluateOps(calm({ gateway: gw({ lastRunAt: minutesAgo(35 * 60) }) }), NOW, null))).toEqual([]);
  });

  it('cobros sin pedido Y conciliación sin hacer a la vez: dos señales, un solo aviso con el fallo mandando', () => {
    const e = evaluateOps(calm({ gateway: gw({ unmatched: 3, errors: 1 }) }), NOW, null);
    expect(keys(e).sort()).toEqual(['gateway_check', 'gateway_unmatched']);
    expect(opsAlertFor(e.raise)).toMatchObject({ severity: 'critical', title: '2 señales de operación' });
  });

  it('`gateway: null` (el front no pudo leerlo en esta pasada) CONSERVA el incidente: ni falso «recuperado» ni aviso doble', () => {
    const first = evaluateOps(calm({ gateway: gw({ unmatched: 2 }) }), NOW, null);
    const line = first.findings.map((f) => f.line).join(' · ');
    const blip = evaluateOps(calm({ gateway: null }), NOW + 5 * MIN, line);
    expect(keys(blip)).toEqual(['gateway_unmatched']);
    expect(blip).toMatchObject({ raise: [], recovered: false });
  });

  it('una pasada que no pudo consultar la pasarela (errors>0, unmatched=0) NO da por resuelto un cobro sin pedido anterior', () => {
    const first = evaluateOps(calm({ gateway: gw({ unmatched: 1 }) }), NOW, null);
    const line = first.findings.map((f) => f.line).join(' · ');
    const failedPass = evaluateOps(calmAt(24 * 60 * MIN, { gateway: gw({ unmatched: 0, errors: 1 }) }), NOW + 24 * 60 * MIN, line);
    expect(keys(failedPass).sort()).toEqual(['gateway_check', 'gateway_unmatched']);
    expect(failedPass.raise.map((f) => f.key)).toEqual(['gateway_check']); // el cobro ya estaba avisado: no se repite como «nuevo»
    expect(failedPass.recovered).toBe(false);
  });

  it('una lista cortada (`truncated`) es un aviso «sin hacer»: puede haber cobros sin mirar', () => {
    const e = evaluateOps(calm({ gateway: gw({ truncated: true }) }), NOW, null);
    expect(keys(e)).toEqual(['gateway_check']);
    expect(e.findings[0].line).toContain('la lista de cobros se cortó');
  });

  it('si el front deja de mandar el campo (rollback), se CONSERVA lo que constaba en vez de darlo por resuelto', () => {
    const first = evaluateOps(calm({ gateway: gw({ unmatched: 1 }) }), NOW, null);
    const line = first.findings.map((f) => f.line).join(' · ');
    const rolledBack = evaluateOps(calm(), NOW + 5 * MIN, line);
    expect(keys(rolledBack)).toEqual(['gateway_unmatched']);
    expect(rolledBack.recovered).toBe(false);
  });
});
