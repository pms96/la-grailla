import { describe, expect, it } from 'vitest';
import { computeReadiness, type ReadinessInput } from '@/lib/services/readiness';

const MIN = '20261009090000_reconcile_queue';
const NEWER = '20261201000000_algo_nuevo';

const READY: ReadinessInput = {
  schemaVersion: MIN,
  latestMigration: MIN,
  minSchema: MIN,
  domains: [{ host: 'demo.test', status: 'VERIFIED', isPrimary: true }],
  published: true,
  pendingChanges: false,
  publishError: null,
  health: { ok: true, status: 'ok', error: null, onboardingComplete: true, onboardingMissing: [] },
};
const state = (input: ReadinessInput, key: string) => computeReadiness(input).steps.find((s) => s.key === key)!;

describe('puesta en marcha de un cliente', () => {
  it('con todo hecho, está completo y no hay siguiente paso', () => {
    const r = computeReadiness(READY);
    expect(r.complete).toBe(true);
    expect(r.next).toBeNull();
    expect(r.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('un cliente recién registrado empieza por migrar la BD', () => {
    const r = computeReadiness({
      ...READY,
      schemaVersion: null,
      domains: [{ host: 'demo.test', status: 'PENDING', isPrimary: true }],
      published: false,
      health: null,
    });
    expect(r.next).toBe('schema');
    expect(state({ ...READY, schemaVersion: null }, 'schema')).toMatchObject({ state: 'todo' });
    expect(r.steps.filter((s) => s.state === 'done')).toHaveLength(0);
  });

  it('un registro por debajo del mínimo que exige el front es un problema (la web muestra mantenimiento)', () => {
    const s = state({ ...READY, schemaVersion: '20261001000000_vieja' }, 'schema');
    expect(s.state).toBe('attention');
    expect(s.detail).toMatch(/mantenimiento/);
    expect(s.detail).toContain(MIN);
  });

  it('migraciones nuevas sin aplicar no son un problema: avisa pero el cliente se sirve', () => {
    const s = state({ ...READY, latestMigration: NEWER }, 'schema');
    expect(s.state).toBe('todo');
    expect(s.detail).toContain(NEWER);
  });

  it('si no se puede leer la carpeta de migraciones, solo cuenta el mínimo exigido', () => {
    expect(state({ ...READY, latestMigration: null }, 'schema').state).toBe('done');
  });

  it('un nombre de migración ilegible nunca cuenta como al día', () => {
    expect(state({ ...READY, schemaVersion: 'cualquier-cosa' }, 'schema').state).toBe('attention');
  });

  it('datos mínimos: sin comprobar, completos o incompletos según la última salud', () => {
    expect(state({ ...READY, health: null }, 'data').state).toBe('todo');
    expect(state(READY, 'data').state).toBe('done');
    const missing = state({ ...READY, health: { ...READY.health!, onboardingComplete: false, onboardingMissing: ['legal_notice', 'admin_email'] } }, 'data');
    expect(missing.state).toBe('attention');
    expect(missing.detail).toContain('legal_notice, admin_email');
  });

  it('dominio: ninguno, pendiente, verificado, y los liberados no cuentan', () => {
    expect(state({ ...READY, domains: [] }, 'domain').state).toBe('attention');
    expect(state({ ...READY, domains: [{ host: 'a.test', status: 'RELEASED', isPrimary: false }] }, 'domain').state).toBe('attention');
    const pending = state({ ...READY, domains: [{ host: 'a.test', status: 'PENDING', isPrimary: true }] }, 'domain');
    expect(pending.state).toBe('todo');
    expect(pending.detail).toContain('a.test');
    expect(state({ ...READY, domains: [{ host: 'a.test', status: 'PENDING', isPrimary: false }, { host: 'b.test', status: 'VERIFIED', isPrimary: false }] }, 'domain').detail).toContain('b.test');
  });

  it('publicación: sin publicar, con cambios pendientes y con error', () => {
    expect(state({ ...READY, published: false }, 'publish').state).toBe('todo');
    expect(state({ ...READY, pendingChanges: true }, 'publish').detail).toMatch(/sin publicar/);
    const failed = state({ ...READY, publishError: 'Upstash caído' }, 'publish');
    expect(failed.state).toBe('attention');
    expect(failed.detail).toContain('Upstash caído');
  });

  it('salud: sin comprobar, correcta o con el error de la última comprobación', () => {
    expect(state({ ...READY, health: null }, 'health').state).toBe('todo');
    const bad = state({ ...READY, health: { ...READY.health!, ok: false, status: 'unreachable', error: 'El cliente no responde' } }, 'health');
    expect(bad.state).toBe('attention');
    expect(bad.detail).toBe('El cliente no responde');
  });

  it('el siguiente paso es el primero sin terminar, aunque haya otros pendientes después', () => {
    const r = computeReadiness({ ...READY, domains: [{ host: 'a.test', status: 'PENDING', isPrimary: true }], published: false, health: null });
    expect(r.next).toBe('data');
    expect(r.complete).toBe(false);
  });
});
