import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { isLocalDatabaseUrl } from '@/scripts/is-local-database-url';
import { FRONT_MIN_SCHEMA } from '@/lib/platform/min-schema';
import { migrationsOnDisk } from '../helpers/migrations';
import { TEST_DB_PREFIX } from '../helpers/tenant-dbs';

/* H-044: `FRONT_MIN_SCHEMA` se subía a mano y se vigilaba por procedimiento: un test solo exigía que la migración existiera y que cada posterior dijera si el front
 * la necesita («not-required»), pero nada comprobaba que ese «no hace falta» fuera verdad. Si una migración marcada así añadía una columna que el código ya lee, los
 * clientes con la BD atrasada daban un 500 en TODAS las lecturas de ese modelo en vez de «en mantenimiento». Esta prueba lo comprueba de verdad: crea una BD vacía,
 * le aplica las migraciones SOLO hasta FRONT_MIN_SCHEMA (lo que el front dice que le basta) y ejecuta el esquema ACTUAL de Prisma contra ella: un `findFirst()` de
 * cada modelo. Una tabla o columna que falte (P2021/P2022) delata que FRONT_MIN_SCHEMA es mentira. */

const DB = `${TEST_DB_PREFIX}minschema`;

function adminAndTargetUrls() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL no está definido: la prueba necesita un Postgres local');
  if (!isLocalDatabaseUrl(raw)) throw new Error('Esta prueba solo funciona contra un Postgres local');
  const admin = new URL(raw);
  admin.pathname = '/postgres';
  const target = new URL(raw);
  target.pathname = `/${DB}`;
  return { admin: admin.toString(), target: target.toString() };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

describe('FRONT_MIN_SCHEMA dice la verdad (H-044)', () => {
  let tmp = '';
  let target = '';
  let admin: PrismaClient;

  beforeAll(async () => {
    const urls = adminAndTargetUrls();
    target = urls.target;
    admin = new PrismaClient({ datasources: { db: { url: urls.admin } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`); // el nombre es una constante (prefijo de test), nunca entrada externa
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DB}"`);

    // Un esquema con SOLO las migraciones hasta FRONT_MIN_SCHEMA (inclusive).
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'min-schema-'));
    fs.copyFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), path.join(tmp, 'schema.prisma'));
    const migrations = path.join(tmp, 'migrations');
    fs.mkdirSync(migrations);
    fs.copyFileSync(path.join(process.cwd(), 'prisma', 'migrations', 'migration_lock.toml'), path.join(migrations, 'migration_lock.toml'));
    for (const name of migrationsOnDisk().filter((n) => /^\d{14}_/.test(n) && n <= FRONT_MIN_SCHEMA)) {
      fs.cpSync(path.join(process.cwd(), 'prisma', 'migrations', name), path.join(migrations, name), { recursive: true });
    }
    execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', path.join(tmp, 'schema.prisma')], { env: { ...process.env, DATABASE_URL: target, DIRECT_URL: target }, stdio: 'pipe' });
  }, 180_000);

  afterAll(async () => {
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => {});
    await admin?.$disconnect();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    // 60 s: con la batería completa en marcha, el `DROP DATABASE … FORCE` tardó más de los 10 s por defecto de un hook (fallo aislado de la suite, no de la prueba).
  }, 60_000);

  it('el esquema actual lee todos sus modelos en una BD que solo tiene hasta FRONT_MIN_SCHEMA', async () => {
    const client = new PrismaClient({ datasources: { db: { url: target } }, log: [] });
    try {
      const broken: string[] = [];
      for (const model of Prisma.dmmf.datamodel.models) {
        try {
          await (client as unknown as Record<string, { findFirst: () => Promise<unknown> }>)[lowerFirst(model.name)].findFirst();
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === 'P2021' || code === 'P2022') broken.push(`${model.name} (${code}: ${(error as Error).message.split('\n').filter(Boolean).pop()})`);
          else throw error;
        }
      }
      expect(broken, `FRONT_MIN_SCHEMA (${FRONT_MIN_SCHEMA}) no basta: el código ya lee tablas o columnas que esa BD no tiene. Súbela a la migración que las crea.`).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  }, 120_000);
});
