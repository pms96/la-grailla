import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/* BDs desechables para los tests del runner y del alta: se crean y destruyen aquí. Salvaguardas: solo un Postgres LOCAL y solo nombres
 * que empiecen por `lagrailla_scratch_` (nunca la BD de control ni una de desarrollo). */

export const SCRATCH_PREFIX = 'lagrailla_scratch_';

function adminUrl(): URL {
  const u = new URL(process.env.CONTROL_DATABASE_URL!);
  if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('Solo un Postgres local');
  u.pathname = '/postgres';
  u.search = '';
  return u;
}

export function scratchUrl(name: string): string {
  if (!name.startsWith(SCRATCH_PREFIX)) throw new Error(`El nombre debe empezar por ${SCRATCH_PREFIX}`);
  const u = adminUrl();
  u.pathname = `/${name}`;
  return u.toString();
}

async function withAdmin<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasourceUrl: adminUrl().toString(), log: [] });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

/** Crea la BD desde cero (la borra si existía). Devuelve su URL. */
export async function createScratchDb(name: string): Promise<string> {
  const url = scratchUrl(name);
  await withAdmin(async (db) => {
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await db.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  });
  return url;
}

export async function dropScratchDb(name: string): Promise<void> {
  scratchUrl(name);
  await withAdmin((db) => db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

export async function scratchDbExists(name: string): Promise<boolean> {
  scratchUrl(name);
  const rows = await withAdmin((db) => db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_database WHERE datname = '${name}'`));
  return rows.length > 0;
}

export async function queryScratch<T = unknown>(name: string, sql: string): Promise<T[]> {
  const db = new PrismaClient({ datasourceUrl: scratchUrl(name), log: [] });
  try {
    return await db.$queryRawUnsafe<T[]>(sql);
  } finally {
    await db.$disconnect();
  }
}

/** Carpeta `prisma/` de mentira (schema vacío + migraciones dadas) para probar el runner sin tocar las migraciones reales. */
export function makeFixturePrismaDir(migrations: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grailla-prisma-fixture-'));
  fs.writeFileSync(path.join(dir, 'schema.prisma'), 'datasource db {\n  provider  = "postgresql"\n  url       = env("DATABASE_URL")\n  directUrl = env("DIRECT_URL")\n}\n');
  fs.mkdirSync(path.join(dir, 'migrations'));
  fs.writeFileSync(path.join(dir, 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
  for (const [name, sql] of Object.entries(migrations)) {
    fs.mkdirSync(path.join(dir, 'migrations', name));
    fs.writeFileSync(path.join(dir, 'migrations', name, 'migration.sql'), sql);
  }
  return dir;
}
