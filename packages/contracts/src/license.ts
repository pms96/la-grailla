import { LICENSE_PHASES, type LicensePhase } from './routing-record';
import { ULID_RE } from './ids';

/* Licencia por fases. Es una función PURA de los plazos y del instante: el panel la usa para publicar y el front para
 * avanzar de fase sin esperar a una republicación.
 *
 *   paidThrough ──► GRACE (graceDays, aviso en el admin)
 *               ──► PANEL_BLOCKED (panelBlockedDays más: admin bloqueado con aviso de pago; web pública y ventas siguen)
 *               ──► BLOCKED (acumulado: paidThrough + graceDays + panelBlockedDays)
 *
 * Con los valores por defecto (7 y 15) el bloqueo total llega a los 22 días. `paidThrough` es el instante (ms epoch) en el que
 * termina la cobertura; `null` = sin caducidad (p. ej. cliente legacy o de cortesía). */

export const DEFAULT_GRACE_DAYS = 7;
export const DEFAULT_PANEL_BLOCKED_DAYS = 15;
const DAY_MS = 86_400_000;

export interface LicenseTerms {
  paidThrough: number | null;
  graceDays: number;
  panelBlockedDays: number;
}

export interface LicenseChange {
  at: number;
  phase: LicensePhase;
}

export interface LicenseState {
  phase: LicensePhase;
  nextPhaseChangeAt: number | null;
  /** Todos los cambios futuros desde el instante calculado, en orden. El front los aplica solo, con una lectura fresca. */
  schedule: LicenseChange[];
}

const RANK: Record<LicensePhase, number> = { ACTIVE: 0, GRACE: 1, PANEL_BLOCKED: 2, BLOCKED: 3 };
export const phaseRank = (phase: LicensePhase): number => RANK[phase];

/** Cambios de fase de unos plazos, desde `paidThrough` (todos, pasados o futuros). */
export function licenseChanges(terms: LicenseTerms): LicenseChange[] {
  if (terms.paidThrough === null) return [];
  const grace = Math.max(0, Math.floor(terms.graceDays));
  const panel = Math.max(0, Math.floor(terms.panelBlockedDays));
  const p = terms.paidThrough;
  return [
    { at: p, phase: 'GRACE' },
    { at: p + grace * DAY_MS, phase: 'PANEL_BLOCKED' },
    { at: p + (grace + panel) * DAY_MS, phase: 'BLOCKED' },
  ];
}

/** Fase en el instante `now` y lo que queda por venir. Un plazo de 0 días salta esa fase (el último cambio gana). */
export function licensePhase(terms: LicenseTerms, now: number): LicenseState {
  const changes = licenseChanges(terms);
  let phase: LicensePhase = 'ACTIVE';
  for (const c of changes) if (c.at <= now) phase = c.phase;
  const schedule = changes.filter((c) => c.at > now);
  return { phase, nextPhaseChangeAt: schedule[0]?.at ?? null, schedule };
}

/**
 * Fase que aplica el front. La del snapshot, más los cambios programados que ya han llegado — pero SOLO si la lectura del registro
 * es fresca: un snapshot servido como obsoleto (registro caído) no puede empeorar la fase por sí solo, porque el cliente puede
 * haber pagado y no verse. Nunca mejora la fase: eso solo lo hace un snapshot nuevo.
 */
export function effectiveLicensePhase(
  license: { phase: LicensePhase; schedule?: readonly LicenseChange[] },
  now: number,
  opts: { fresh: boolean }
): LicensePhase {
  if (!opts.fresh || !license.schedule) return license.phase;
  let phase = license.phase;
  for (const c of license.schedule) if (c.at <= now && RANK[c.phase] > RANK[phase]) phase = c.phase;
  return phase;
}

export function isLicensePhase(value: string): value is LicensePhase {
  return (LICENSE_PHASES as readonly string[]).includes(value);
}

/** Clave del registro con la revocación de emergencia de un cliente (la escribe el panel; la presencia del valor corta el acceso). */
export function registryKeyForRevocation(tenantId: string): string {
  if (!ULID_RE.test(tenantId)) throw new Error('tenantId no válido para el registro');
  return `revoked:${tenantId}`;
}
