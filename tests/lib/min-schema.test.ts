import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSchemaAtLeast } from '@grailla/contracts';
import { FRONT_MIN_SCHEMA } from '@/lib/platform/min-schema';
import { expectedSchema } from '@/lib/platform/expected-schema';
import { latestMigrationOnDisk } from '../helpers/migrations';

describe('FRONT_MIN_SCHEMA', () => {
  it('es una carpeta que existe en prisma/migrations', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'prisma', 'migrations', FRONT_MIN_SCHEMA, 'migration.sql'))).toBe(true);
  });

  it('no es posterior a la última migración del repo (no se puede exigir lo que no existe)', () => {
    expect(isSchemaAtLeast(latestMigrationOnDisk(), FRONT_MIN_SCHEMA)).toBe(true);
  });
});

describe('expectedSchema', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('usa FRONT_SCHEMA_EXPECTED, que next.config.js rellena con la última carpeta de migraciones', () => {
    vi.stubEnv('FRONT_SCHEMA_EXPECTED', latestMigrationOnDisk());
    expect(expectedSchema()).toBe(latestMigrationOnDisk());
  });

  it('sin la variable (script o test fuera de Next) cae a la mínima exigida', () => {
    vi.stubEnv('FRONT_SCHEMA_EXPECTED', '');
    expect(expectedSchema()).toBe(FRONT_MIN_SCHEMA);
  });

  it('next.config.js calcula lo mismo que el helper de tests (la última carpeta)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../../next.config.js') as { env: { FRONT_SCHEMA_EXPECTED: string } };
    expect(config.env.FRONT_SCHEMA_EXPECTED).toBe(latestMigrationOnDisk());
  });
});
