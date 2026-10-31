import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '../../scripts/ignore-build.js');
const { freezeDecision, BYPASS_MARKER } = createRequire(import.meta.url)(script) as {
  freezeDecision: (env: Record<string, string | undefined>, now?: number) => { skip: boolean; reason: string };
  BYPASS_MARKER: string;
};

/* P1-22 · OB-14: la congelación de despliegues en venta (Ignored Build Step de Vercel). `skip: true` = NO construir. */

const NOW = Date.parse('2026-11-14T20:00:00Z');
const prod = (extra: Record<string, string> = {}) => ({ VERCEL_ENV: 'production', ...extra });

describe('scripts/ignore-build.js: ¿se congela este despliegue?', () => {
  it('por defecto se construye todo (sin variables, producción incluida)', () => {
    expect(freezeDecision({}, NOW).skip).toBe(false);
    expect(freezeDecision(prod(), NOW)).toMatchObject({ skip: false, reason: 'sin congelación activa' });
    expect(freezeDecision(prod({ SALES_FREEZE: '0', SALES_FREEZE_UNTIL: '' }), NOW).skip).toBe(false);
  });

  it('SALES_FREEZE=1 congela los despliegues de producción', () => {
    const d = freezeDecision(prod({ SALES_FREEZE: '1' }), NOW);
    expect(d.skip).toBe(true);
    expect(d.reason).toMatch(/congelación de despliegues activa/);
    expect(d.reason).toContain(BYPASS_MARKER);
  });

  it('las vistas previas y otros entornos NO se congelan', () => {
    expect(freezeDecision({ VERCEL_ENV: 'preview', SALES_FREEZE: '1' }, NOW).skip).toBe(false);
    expect(freezeDecision({ VERCEL_ENV: 'development', SALES_FREEZE: '1' }, NOW).skip).toBe(false);
    expect(freezeDecision({ SALES_FREEZE: '1' }, NOW).skip).toBe(false);
  });

  it('SALES_FREEZE_UNTIL congela hasta esa fecha y se levanta solo', () => {
    expect(freezeDecision(prod({ SALES_FREEZE_UNTIL: '2026-11-14T23:00:00Z' }), NOW)).toMatchObject({ skip: true });
    expect(freezeDecision(prod({ SALES_FREEZE_UNTIL: '2026-11-14T19:59:59Z' }), NOW)).toMatchObject({ skip: false, reason: 'sin congelación activa' });
    expect(freezeDecision(prod({ SALES_FREEZE_UNTIL: '2026-11-14T20:00:00Z' }), NOW).skip).toBe(false); // justo en el límite: ya pasó
  });

  it('una fecha ilegible CONGELA por prudencia y lo dice (equivocarse al escribirla no deja la venta sin protección)', () => {
    const d = freezeDecision(prod({ SALES_FREEZE_UNTIL: 'el sábado' }), NOW);
    expect(d.skip).toBe(true);
    expect(d.reason).toMatch(/no es una fecha válida/);
  });

  it('SALES_FREEZE acepta las formas habituales de «sí» (sin importar mayúsculas ni espacios), no congela con «no», y ante algo raro congela', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'si', 'On', 'quizá']) expect(freezeDecision(prod({ SALES_FREEZE: v }), NOW).skip, v).toBe(true);
    for (const v of ['', '0', 'false', 'No', 'OFF', '  ']) expect(freezeDecision(prod({ SALES_FREEZE: v }), NOW).skip, JSON.stringify(v)).toBe(false);
  });

  it('SALES_FREEZE_UNTIL sin zona horaria CONGELA y lo dice: sin ella, Vercel la leería en UTC y descongelaría horas antes de lo previsto', () => {
    for (const v of ['2026-11-14', '2026-11-14T23:00:00', '2026-11-14 23:00']) {
      const d = freezeDecision(prod({ SALES_FREEZE_UNTIL: v }), NOW);
      expect(d.skip, v).toBe(true);
      expect(d.reason, v).toMatch(/no lleva zona horaria/);
    }
    // Con zona (Z o desplazamiento) se respeta la hora exacta: las 23:00 de Madrid son las 22:00Z.
    expect(freezeDecision(prod({ SALES_FREEZE_UNTIL: '2026-11-14T23:00:00+01:00' }), NOW).skip).toBe(true);
    expect(freezeDecision(prod({ SALES_FREEZE_UNTIL: '2026-11-14T20:30:00+0100' }), NOW).skip).toBe(false); // 19:30Z: ya pasó
  });

  it('SALES_FREEZE=1 manda aunque SALES_FREEZE_UNTIL ya haya pasado', () => {
    expect(freezeDecision(prod({ SALES_FREEZE: '1', SALES_FREEZE_UNTIL: '2020-01-01T00:00:00Z' }), NOW).skip).toBe(true);
  });

  it('un commit con [deploy-anyway] se construye aunque haya congelación (arreglo urgente)', () => {
    const d = freezeDecision(prod({ SALES_FREEZE: '1', VERCEL_GIT_COMMIT_MESSAGE: `Arreglo del checkout ${BYPASS_MARKER}` }), NOW);
    expect(d.skip).toBe(false);
    expect(d.reason).toMatch(/se construye/);
    expect(freezeDecision(prod({ SALES_FREEZE: '1', VERCEL_GIT_COMMIT_MESSAGE: 'Arreglo del checkout' }), NOW).skip).toBe(true);
  });

  it('ejecutado como script respeta la convención de Vercel: 0 = no construir, 1 = construir', () => {
    const run = (env: Record<string, string>) => spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
    const frozen = run({ VERCEL_ENV: 'production', SALES_FREEZE: '1' });
    expect(frozen.status).toBe(0);
    expect(frozen.stdout).toMatch(/\[ignore-build\].*congelación/);
    expect(run({ VERCEL_ENV: 'production' }).status).toBe(1);
    expect(run({}).status).toBe(1);
  });
});
