import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRACE_DAYS,
  DEFAULT_PANEL_BLOCKED_DAYS,
  RoutingRecordSchema,
  effectiveLicensePhase,
  licensePhase,
  registryKeyForRevocation,
  type LicenseTerms,
} from '../src';

const DAY = 86_400_000;
const PAID = 1_800_000_000_000;
const terms = (over: Partial<LicenseTerms> = {}): LicenseTerms => ({ paidThrough: PAID, graceDays: DEFAULT_GRACE_DAYS, panelBlockedDays: DEFAULT_PANEL_BLOCKED_DAYS, ...over });

describe('licensePhase', () => {
  it('los plazos por defecto son 7 y 15 días (el bloqueo total llega a los 22)', () => {
    expect(DEFAULT_GRACE_DAYS + DEFAULT_PANEL_BLOCKED_DAYS).toBe(22);
  });

  it('ACTIVE hasta paidThrough (exclusive), y se anuncia el siguiente cambio', () => {
    expect(licensePhase(terms(), PAID - 1)).toMatchObject({ phase: 'ACTIVE', nextPhaseChangeAt: PAID });
    expect(licensePhase(terms(), PAID - 400 * DAY).phase).toBe('ACTIVE');
  });

  it('límites exactos: día 0 → GRACE, día 7 → PANEL_BLOCKED, día 22 → BLOCKED', () => {
    expect(licensePhase(terms(), PAID).phase).toBe('GRACE');
    expect(licensePhase(terms(), PAID + 7 * DAY - 1).phase).toBe('GRACE');
    expect(licensePhase(terms(), PAID + 7 * DAY).phase).toBe('PANEL_BLOCKED');
    expect(licensePhase(terms(), PAID + 22 * DAY - 1).phase).toBe('PANEL_BLOCKED');
    expect(licensePhase(terms(), PAID + 22 * DAY).phase).toBe('BLOCKED');
    expect(licensePhase(terms(), PAID + 400 * DAY)).toMatchObject({ phase: 'BLOCKED', nextPhaseChangeAt: null, schedule: [] });
  });

  it('los plazos son configurables y se acumulan', () => {
    const t = terms({ graceDays: 3, panelBlockedDays: 10 });
    expect(licensePhase(t, PAID + 3 * DAY).phase).toBe('PANEL_BLOCKED');
    expect(licensePhase(t, PAID + 13 * DAY - 1).phase).toBe('PANEL_BLOCKED');
    expect(licensePhase(t, PAID + 13 * DAY).phase).toBe('BLOCKED');
  });

  it('un plazo de 0 días salta esa fase', () => {
    expect(licensePhase(terms({ graceDays: 0 }), PAID).phase).toBe('PANEL_BLOCKED');
    expect(licensePhase(terms({ graceDays: 0, panelBlockedDays: 0 }), PAID).phase).toBe('BLOCKED');
  });

  it('sin paidThrough no caduca nunca', () => {
    expect(licensePhase(terms({ paidThrough: null }), PAID * 10)).toEqual({ phase: 'ACTIVE', nextPhaseChangeAt: null, schedule: [] });
  });

  it('el calendario lista solo los cambios futuros y en orden', () => {
    const s = licensePhase(terms(), PAID - DAY);
    expect(s.schedule.map((c) => c.phase)).toEqual(['GRACE', 'PANEL_BLOCKED', 'BLOCKED']);
    expect(licensePhase(terms(), PAID + 8 * DAY).schedule.map((c) => c.phase)).toEqual(['BLOCKED']);
  });
});

describe('effectiveLicensePhase (lo que aplica el front)', () => {
  const published = licensePhase(terms(), PAID - DAY); // snapshot publicado un día antes de caducar

  it('con lectura fresca avanza sola por el calendario, sin republicar', () => {
    expect(effectiveLicensePhase(published, PAID + 8 * DAY, { fresh: true })).toBe('PANEL_BLOCKED');
    expect(effectiveLicensePhase(published, PAID + 30 * DAY, { fresh: true })).toBe('BLOCKED');
  });

  it('un snapshot servido como obsoleto NO empeora la fase por sí solo (el cliente pudo pagar y no verse)', () => {
    expect(effectiveLicensePhase(published, PAID + 30 * DAY, { fresh: false })).toBe('ACTIVE');
  });

  it('nunca mejora la fase: eso solo lo hace un snapshot nuevo', () => {
    const blocked = { phase: 'BLOCKED' as const, schedule: [{ at: PAID, phase: 'GRACE' as const }] };
    expect(effectiveLicensePhase(blocked, PAID + DAY, { fresh: true })).toBe('BLOCKED');
  });

  it('un snapshot antiguo sin calendario se queda con su fase', () => {
    expect(effectiveLicensePhase({ phase: 'GRACE' }, PAID * 2, { fresh: true })).toBe('GRACE');
  });
});

describe('contrato', () => {
  const record = (license: unknown) => ({
    tenantId: '01HF7YAT00AAAAAAAAAAAAAAAA',
    product: 'grailla',
    cell: 'shared-1',
    status: 'ACTIVE',
    modules: [],
    license,
    primaryDomain: 'a.cliente.es',
    domains: ['a.cliente.es'],
    schemaVersion: null,
    epoch: 0,
  });

  it('el calendario es opcional: un snapshot anterior sigue siendo válido', () => {
    expect(RoutingRecordSchema.safeParse(record({ phase: 'ACTIVE', nextPhaseChangeAt: null })).success).toBe(true);
    const s = licensePhase(terms(), PAID - DAY);
    expect(RoutingRecordSchema.safeParse(record(s)).success).toBe(true);
  });

  it('una fase desconocida invalida el registro', () => {
    expect(RoutingRecordSchema.safeParse(record({ phase: 'VIP', nextPhaseChangeAt: null })).success).toBe(false);
  });

  it('la clave de revocación exige un ULID', () => {
    expect(registryKeyForRevocation('01HF7YAT00AAAAAAAAAAAAAAAA')).toBe('revoked:01HF7YAT00AAAAAAAAAAAAAAAA');
    expect(() => registryKeyForRevocation('no-es-un-ulid')).toThrow();
  });
});
