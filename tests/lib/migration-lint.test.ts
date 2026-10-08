import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { lintMigrationSql, lintMigrationsDir, migrationsToCheck } from '@/scripts/migration-lint';

const rules = (sql: string) => lintMigrationSql(sql).map((f) => f.rule);

describe('lintMigrationSql', () => {
  it('acepta migraciones aditivas', () => {
    expect(
      rules(`
        -- CreateTable
        CREATE TABLE "ContactMessage" ("id" TEXT NOT NULL, "body" TEXT NOT NULL, CONSTRAINT "ContactMessage_pkey" PRIMARY KEY ("id"));
        -- AlterTable
        ALTER TABLE "Event" ADD COLUMN "slugAlt" TEXT;
        ALTER TABLE "Order" ADD COLUMN "flag" BOOLEAN NOT NULL DEFAULT false;
        CREATE INDEX "Order_flag_idx" ON "Order"("flag");
        ALTER TABLE "Order" ALTER COLUMN "notes" DROP NOT NULL;
        ALTER TYPE "TicketStatus" ADD VALUE 'HOLD';
      `)
    ).toEqual([]);
  });

  it.each([
    ['DROP TABLE "Old";', 'drop-table'],
    ['ALTER TABLE "Event" DROP COLUMN "venue";', 'drop-column'],
    ['DROP TYPE "OldEnum";', 'drop-type'],
    ['ALTER TABLE "Event" RENAME COLUMN "a" TO "b";', 'rename'],
    ['ALTER TABLE "Event" RENAME TO "Events";', 'rename'],
    ['ALTER TABLE "Order" ALTER COLUMN "total" SET DATA TYPE DECIMAL(10,2);', 'alter-type'],
    ['ALTER TABLE "Order" ALTER COLUMN "total" TYPE INTEGER;', 'alter-type'],
    ['ALTER TABLE "Order" ALTER COLUMN "notes" SET NOT NULL;', 'set-not-null'],
    ['TRUNCATE "RateLimitBucket";', 'truncate'],
    ['DELETE FROM "Order";', 'delete-from'],
    ['ALTER TABLE "Order" ADD COLUMN "flag" BOOLEAN NOT NULL;', 'add-not-null-column'],
    ['ALTER TABLE "Order" ADD COLUMN "a" TEXT, ADD COLUMN "b" TEXT NOT NULL;', 'add-not-null-column'],
  ])('rechaza: %s', (sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it('ignora lo que solo aparece en comentarios', () => {
    expect(rules('-- DROP TABLE "Old";\n/* DELETE FROM "x" */\nCREATE TABLE "A" ("id" TEXT);')).toEqual([]);
  });

  it('una migración que declara -- allow-destructive queda permitida', () => {
    expect(rules('-- allow-destructive: contract tras migrar todos los tenants\nALTER TABLE "Event" DROP COLUMN "venue";')).toEqual([]);
  });

  it('el marcador sin motivo no vale', () => {
    expect(rules('-- allow-destructive:\nDROP TABLE "Old";')).toContain('drop-table');
  });
});

describe('migrationsToCheck', () => {
  it('solo revisa las posteriores a la línea base', () => {
    const names = ['20260813132955_init', '20260930110333_add_ingreso_model', '20261001000000_nueva', 'migration_lock.toml'];
    expect(migrationsToCheck(names, '20260930110333_add_ingreso_model')).toEqual(['20261001000000_nueva']);
  });
});

describe('prisma/migrations del repo', () => {
  it('todas las migraciones posteriores a la línea base son aditivas', () => {
    const dir = path.join(process.cwd(), 'prisma', 'migrations');
    expect(fs.existsSync(dir)).toBe(true);
    expect(lintMigrationsDir(dir)).toEqual([]);
  });
});
