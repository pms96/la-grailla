import fs from 'node:fs';
import path from 'node:path';

/** Nombres de las carpetas de `prisma/migrations`, ordenados (la marca de tiempo del nombre ordena igual que Prisma). */
export function migrationsOnDisk(): string[] {
  const dir = path.join(process.cwd(), 'prisma', 'migrations');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Lo que `next.config.js` inyecta como FRONT_SCHEMA_EXPECTED en un build real. */
export function latestMigrationOnDisk(): string {
  const all = migrationsOnDisk();
  return all[all.length - 1];
}
