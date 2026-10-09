import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkMinSchemaDecisions } from '@/scripts/migration-lint';
import { FRONT_MIN_SCHEMA } from '@/lib/platform/min-schema';

/* Olvidar subir FRONT_MIN_SCHEMA da un 500 en todas las lecturas de un modelo en los clientes con la BD atrasada (en vez de «en mantenimiento»).
 * Cada migración posterior a la puerta debe decidir por escrito si el front la necesita. */

const dirs: string[] = [];
function migrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grailla-min-schema-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'migration.sql'), sql);
  }
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const MIN = '20261009090000_reconcile_queue';

describe('migraciones posteriores a FRONT_MIN_SCHEMA', () => {
  it('las anteriores o iguales no necesitan decisión', () => {
    const dir = migrationsDir({ '20260101000000_vieja': 'CREATE TABLE a();', [MIN]: 'ALTER TABLE "Order" ADD COLUMN "x" TEXT;' });
    expect(checkMinSchemaDecisions(dir, MIN)).toEqual([]);
  });

  it('una posterior sin decisión se rechaza y dice qué hacer', () => {
    const dir = migrationsDir({ [MIN]: 'x', '20261101000000_nueva': 'ALTER TABLE "Order" ADD COLUMN "y" TEXT;' });
    const findings = checkMinSchemaDecisions(dir, MIN);
    expect(findings).toHaveLength(1);
    expect(findings[0].migration).toBe('20261101000000_nueva');
    expect(findings[0].message).toContain('FRONT_MIN_SCHEMA');
    expect(findings[0].message).toContain('not-required');
  });

  it('con «-- front-min-schema: not-required <motivo>» se acepta', () => {
    const dir = migrationsDir({ '20261101000000_nueva': '-- front-min-schema: not-required el front aún no lee esta columna\nALTER TABLE "Order" ADD COLUMN "y" TEXT;' });
    expect(checkMinSchemaDecisions(dir, MIN)).toEqual([]);
  });

  it('sin motivo no vale', () => {
    const dir = migrationsDir({ '20261101000000_nueva': '-- front-min-schema: not-required\nALTER TABLE "Order" ADD COLUMN "y" TEXT;' });
    expect(checkMinSchemaDecisions(dir, MIN)).toHaveLength(1);
  });

  it('subir FRONT_MIN_SCHEMA a la migración también resuelve (deja de ser posterior)', () => {
    const dir = migrationsDir({ '20261101000000_nueva': 'ALTER TABLE "Order" ADD COLUMN "y" TEXT;' });
    expect(checkMinSchemaDecisions(dir, '20261101000000_nueva')).toEqual([]);
  });

  it('las migraciones reales del repo están al día con la puerta actual', () => {
    expect(checkMinSchemaDecisions(path.join(process.cwd(), 'prisma', 'migrations'), FRONT_MIN_SCHEMA)).toEqual([]);
  });
});
