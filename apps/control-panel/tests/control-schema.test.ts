import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { EXPECTED_CONTROL_SCHEMA, compareControlSchema, controlSchemaNotice, controlSchemaStatus, resetControlSchemaCache } from '@/lib/services/control-schema';

/* Lote 16 (B): el build del panel NO migra su propia BD de control (se hace a mano o con el workflow «Migrar la BD de control»). Un panel desplegado con la BD atrasada rompe el inicio de
 * sesión justo cuando haría falta ver un aviso, así que el aviso va en el layout raíz (también antes de iniciar sesión) y el latido del disparador pasa a «fallo». */
const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

beforeEach(resetControlSchemaCache);
afterEach(() => vi.restoreAllMocks());

describe('EXPECTED_CONTROL_SCHEMA', () => {
  it('es la última migración que hay en prisma/migrations (al añadir una nueva hay que actualizarla)', () => {
    const names = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
    expect(EXPECTED_CONTROL_SCHEMA).toBe(names.at(-1));
  });
});

describe('compareControlSchema', () => {
  it('igual o por delante de lo esperado: ok', () => {
    expect(compareControlSchema('20261102120000_operator_login_buckets', '20261102120000_operator_login_buckets')).toBe('ok');
    expect(compareControlSchema('20270101000000_futura', '20261102120000_operator_login_buckets')).toBe('ok'); // la BD va por delante del panel desplegado: no es un problema
  });
  it('por detrás de lo esperado: behind', () => {
    expect(compareControlSchema('20261009120000_db_fingerprint', '20261102120000_operator_login_buckets')).toBe('behind');
  });
  it('sin ninguna migración aplicada que leer: unknown (no se afirma nada)', () => {
    expect(compareControlSchema(null, '20261102120000_operator_login_buckets')).toBe('unknown');
  });
});

describe('controlSchemaStatus (contra la BD de control de pruebas)', () => {
  it('con la BD al día: ok y lo aplicado es lo esperado', async () => {
    const s = await controlSchemaStatus({ fresh: true });
    expect(s).toMatchObject({ state: 'ok', applied: EXPECTED_CONTROL_SCHEMA, expected: EXPECTED_CONTROL_SCHEMA });
  });

  it('si el panel espera una migración que la BD no tiene: behind', async () => {
    const s = await controlSchemaStatus({ fresh: true, expected: '29991231235959_futura' });
    expect(s.state).toBe('behind');
    expect(s.applied).toBe(EXPECTED_CONTROL_SCHEMA);
  });

  it('no consulta la BD más de una vez cada 30 s', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw');
    const t0 = Date.now();
    await controlSchemaStatus({ now: t0, fresh: true });
    await controlSchemaStatus({ now: t0 + 5_000 });
    await controlSchemaStatus({ now: t0 + 29_000 });
    expect(spy).toHaveBeenCalledTimes(1);
    await controlSchemaStatus({ now: t0 + 31_000 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('`fresh` fuerza una lectura nueva aunque la guardada sea reciente (tras migrar, el aviso desaparece sin esperar 30 s)', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw');
    const t0 = Date.now();
    await controlSchemaStatus({ now: t0, fresh: true });
    await controlSchemaStatus({ now: t0 + 1_000, fresh: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('si la lectura falla devuelve unknown y no lanza (un aviso nunca puede tumbar una página)', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('relation "_prisma_migrations" does not exist'));
    const s = await controlSchemaStatus({ fresh: true });
    expect(s).toMatchObject({ state: 'unknown', applied: null });
  });
});

describe('controlSchemaNotice', () => {
  it('solo hay aviso cuando la BD está por detrás; dice qué hacer y NO nombra migraciones (se ve también antes de iniciar sesión)', () => {
    expect(controlSchemaNotice({ state: 'ok', applied: 'a', expected: 'a' })).toBeNull();
    expect(controlSchemaNotice({ state: 'unknown', applied: null, expected: 'a' })).toBeNull();
    const n = controlSchemaNotice({ state: 'behind', applied: '20261009120000_db_fingerprint', expected: '20261102120000_operator_login_buckets' })!;
    expect(n.title).toMatch(/migración/i);
    expect(n.detail).toMatch(/Migrar la BD de control/);
    expect(n.detail).toMatch(/db:migrate/);
    expect(JSON.stringify(n)).not.toMatch(/operator_login_buckets|db_fingerprint|\d{14}/);
  });
});

describe('el aviso está en el layout raíz', () => {
  it('layout.tsx pinta ControlSchemaNotice y el componente lee el estado real de la BD', () => {
    expect(read('app/layout.tsx')).toMatch(/import \{ ControlSchemaNotice \} from '\.\/_components\/control-schema-notice';/);
    expect(read('app/layout.tsx')).toMatch(/<ControlSchemaNotice \/>/);
    const c = read('app/_components/control-schema-notice.tsx');
    expect(c).toMatch(/controlSchemaStatus\(\)/);
    expect(c).toMatch(/role="alert"/);
  });
});
