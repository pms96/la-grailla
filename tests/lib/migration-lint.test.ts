import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LOCK_RULES_SINCE, lintLockingSql, lintMigrationSql, lintMigrationsDir, migrationsToCheck } from '@/scripts/migration-lint';

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

// H-045: el linter solo miraba lo destructivo. Una migración ADITIVA también puede dejar sin escrituras una tabla viva: `CREATE INDEX` sobre una tabla que ya existe
// (bloquea las escrituras mientras se construye), `ADD CONSTRAINT` (recorre toda la tabla bajo bloqueo), un `UPDATE` de relleno (bloquea filas) o `DROP INDEX`; y
// `CREATE INDEX CONCURRENTLY`, la salida habitual, no se puede usar porque el runner migra dentro de una transacción. Esas sentencias exigen una línea
// `-- allow-lock: <motivo>`: queda a la vista en la revisión. Solo se aplica a las migraciones posteriores a `LOCK_RULES_SINCE` (las anteriores ya están aplicadas).
describe('lintLockingSql (H-045)', () => {
  const lock = (sql: string) => lintLockingSql(sql).map((f) => f.rule);

  it.each([
    ['CREATE INDEX "Order_x_idx" ON "Order"("x");', 'create-index-existing-table'],
    ['CREATE UNIQUE INDEX IF NOT EXISTS "Order_y_key" ON "Order"("y");', 'create-index-existing-table'],
    ['CREATE INDEX CONCURRENTLY "Order_z_idx" ON "Order"("z");', 'create-index-concurrently'],
    ['ALTER TABLE "Order" ADD CONSTRAINT "Order_chk" CHECK ("total" >= 0);', 'add-constraint-existing-table'],
    ['ALTER TABLE ONLY "Order" ADD CONSTRAINT "Order_fk" FOREIGN KEY ("a") REFERENCES "B"("id");', 'add-constraint-existing-table'],
    ['UPDATE "Order" SET "flag" = true WHERE "flag" IS NULL;', 'backfill-update'],
    ['DROP INDEX "Order_x_idx";', 'drop-index'],
    ['DROP INDEX IF EXISTS "Order_x_idx";', 'drop-index'],
  ])('marca: %s', (sql, rule) => {
    expect(lock(sql)).toContain(rule);
  });

  it('una tabla creada en la MISMA migración es nueva y no está en uso: sus índices y restricciones no bloquean nada', () => {
    expect(
      lock(`
        CREATE TABLE "Slot" ("ref" TEXT NOT NULL, "scope" TEXT NOT NULL, CONSTRAINT "Slot_pkey" PRIMARY KEY ("ref"));
        CREATE INDEX "Slot_scope_idx" ON "Slot"("scope");
        CREATE UNIQUE INDEX IF NOT EXISTS "Slot_ref_key" ON "Slot"("ref");
        ALTER TABLE "Slot" ADD CONSTRAINT "Slot_fk" FOREIGN KEY ("scope") REFERENCES "Order"("id");
        UPDATE "Slot" SET "scope" = 'x';
      `)
    ).toEqual([]);
  });

  it('un índice sobre una tabla vieja junto a una tabla nueva sí se marca', () => {
    expect(lock('CREATE TABLE "Slot" ("ref" TEXT);\nCREATE INDEX "Order_a_idx" ON "Order"("a");')).toEqual(['create-index-existing-table']);
  });

  it('ADD COLUMN, tablas nuevas y valores de enum no bloquean: no se marcan', () => {
    expect(lock('ALTER TABLE "Order" ADD COLUMN "flag" BOOLEAN NOT NULL DEFAULT false;\nALTER TYPE "S" ADD VALUE \'X\';\nINSERT INTO "AppConfig" ("key") VALUES (\'a\');')).toEqual([]);
  });

  it('ignora lo que solo aparece en comentarios', () => {
    expect(lock('-- CREATE INDEX "a" ON "Order"("x");\n/* UPDATE "Order" SET "a" = 1 */\nSELECT 1;')).toEqual([]);
  });

  it('`-- allow-lock: <motivo>` lo deja pasar; sin motivo no vale', () => {
    expect(lock('-- allow-lock: tabla pequeña, el runner no migra con venta en marcha\nCREATE INDEX "Order_x_idx" ON "Order"("x");')).toEqual([]);
    expect(lock('-- allow-lock:\nCREATE INDEX "Order_x_idx" ON "Order"("x");')).toContain('create-index-existing-table');
  });
});

describe('prisma/migrations del repo: bloqueos (H-045)', () => {
  it('las migraciones posteriores a LOCK_RULES_SINCE no dejan tablas vivas sin escrituras sin decirlo', () => {
    const dir = path.join(process.cwd(), 'prisma', 'migrations');
    const names = fs.readdirSync(dir).filter((n) => /^\d{14}_/.test(n) && n > LOCK_RULES_SINCE);
    for (const n of names) {
      const sql = fs.readFileSync(path.join(dir, n, 'migration.sql'), 'utf8');
      expect(lintLockingSql(sql), n).toEqual([]);
    }
  });

  it('`lintMigrationsDir` aplica las reglas de bloqueo solo a las posteriores a LOCK_RULES_SINCE', () => {
    const tmp = fs.mkdtempSync(path.join(process.cwd(), 'tmp-lint-'));
    try {
      for (const [name, sql] of [
        ['20261101110000_vieja', 'UPDATE "Order" SET "a" = 1;'],
        ['20261101999999_nueva', 'UPDATE "Order" SET "a" = 1;'],
      ]) {
        fs.mkdirSync(path.join(tmp, name));
        fs.writeFileSync(path.join(tmp, name, 'migration.sql'), sql);
      }
      const found = lintMigrationsDir(tmp, '20260930110333_add_ingreso_model');
      expect(found.map((f) => f.migration)).toEqual(['20261101999999_nueva']);
      expect(found[0].findings.map((f) => f.rule)).toEqual(['backfill-update']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

