/* Política de migraciones: expand/contract.
 *
 * Un único front va a servir a BDs que, durante unos minutos, están en
 * versiones de schema distintas, y Prisma selecciona columnas explícitas: una
 * columna que el código espera y la BD no tiene da un 500 en TODAS las lecturas
 * de ese modelo, no solo en la funcionalidad nueva. Por eso una migración debe
 * ser compatible hacia atrás con el código anterior: solo ADITIVA (tabla
 * nueva, columna nullable o con DEFAULT, índice). Renombrar, borrar, cambiar un
 * tipo o hacer una columna NOT NULL se hace en un release posterior
 * ("contract"), cuando ningún despliegue ejecute ya el código antiguo.
 *
 * Una migración que de verdad necesita ser destructiva lo declara con una línea
 * `-- allow-destructive: <motivo>` — queda a la vista en la revisión.
 *
 * Solo se revisan las migraciones POSTERIORES a BASELINE_MIGRATION: las
 * anteriores ya están aplicadas en producción. */

import fs from 'fs';
import path from 'path';
import { FRONT_MIN_SCHEMA } from '../lib/platform/min-schema';

export const BASELINE_MIGRATION = '20260930110333_add_ingreso_model';

export type LintFinding = { rule: string; message: string };

const ALLOW_MARKER = /^[ \t]*--[ \t]*allow-destructive:[ \t]*\S+/im;

const RULES: { rule: string; re: RegExp; message: string }[] = [
  { rule: 'drop-table', re: /\bDROP\s+TABLE\b/i, message: 'DROP TABLE: borra datos y rompe el código anterior' },
  { rule: 'drop-column', re: /\bDROP\s+COLUMN\b/i, message: 'DROP COLUMN: el código anterior sigue seleccionando esa columna' },
  { rule: 'drop-type', re: /\bDROP\s+TYPE\b/i, message: 'DROP TYPE: borra un enum que el código anterior puede usar' },
  { rule: 'rename', re: /\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b|\bALTER\s+TABLE\s+\S+\s+RENAME\b/i, message: 'RENAME: el código anterior usa el nombre antiguo' },
  { rule: 'alter-type', re: /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i, message: 'cambio de tipo: reescribe la tabla bajo bloqueo y puede romper el código anterior' },
  { rule: 'set-not-null', re: /\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i, message: 'SET NOT NULL: los inserts del código anterior fallarían' },
  { rule: 'truncate', re: /\bTRUNCATE\b/i, message: 'TRUNCATE: borra datos' },
  { rule: 'delete-from', re: /\bDELETE\s+FROM\b/i, message: 'DELETE FROM: borra datos' },
];

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ADD COLUMN ... NOT NULL sin DEFAULT: los inserts del código anterior (que no
// conocen la columna) fallarían.
function findNotNullWithoutDefault(sql: string): boolean {
  const statements = sql.split(';');
  return statements.some((stmt) => {
    if (!/\bADD\s+COLUMN\b/i.test(stmt)) return false;
    return stmt
      .split(/,(?![^(]*\))/)
      .some((part) => /\bADD\s+COLUMN\b/i.test(part) && /\bNOT\s+NULL\b/i.test(part) && !/\bDEFAULT\b/i.test(part));
  });
}

export function lintMigrationSql(rawSql: string): LintFinding[] {
  if (ALLOW_MARKER.test(rawSql)) return [];
  const sql = stripComments(rawSql);
  const findings: LintFinding[] = RULES.filter(({ re }) => re.test(sql)).map(({ rule, message }) => ({ rule, message }));
  if (findNotNullWithoutDefault(sql)) {
    findings.push({
      rule: 'add-not-null-column',
      message: 'ADD COLUMN ... NOT NULL sin DEFAULT: los inserts del código anterior fallarían',
    });
  }
  return findings;
}

export function migrationsToCheck(names: string[], baseline = BASELINE_MIGRATION): string[] {
  return names.filter((n) => /^\d{14}_/.test(n) && n > baseline).sort();
}

export function lintMigrationsDir(dir: string, baseline = BASELINE_MIGRATION): { migration: string; findings: LintFinding[] }[] {
  const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
  return migrationsToCheck(names, baseline).flatMap((name) => {
    const file = path.join(dir, name, 'migration.sql');
    if (!fs.existsSync(file)) return [];
    const findings = lintMigrationSql(fs.readFileSync(file, 'utf8'));
    return findings.length ? [{ migration: name, findings }] : [];
  });
}

/* Puerta de esquema (FRONT_MIN_SCHEMA): olvidar subirla cuando el código empieza a leer una columna nueva hace que los clientes con la BD
 * por detrás den un 500 en TODAS las lecturas de ese modelo (Prisma selecciona todas las columnas) en vez de «en mantenimiento». Como
 * «¿lo necesita el código?» no se puede saber desde fuera, cada migración posterior a FRONT_MIN_SCHEMA obliga a decidirlo por escrito:
 *   - el código de este release la necesita → se sube FRONT_MIN_SCHEMA a esa migración (y deja de estar «posterior»);
 *   - el front funciona sin ella → `-- front-min-schema: not-required <motivo>` en su migration.sql. */
const NOT_REQUIRED_MARKER = /^[ \t]*--[ \t]*front-min-schema:[ \t]*not-required[ \t]+\S+/im;

export type MinSchemaFinding = { migration: string; message: string };

export function checkMinSchemaDecisions(dir: string, min: string = FRONT_MIN_SCHEMA): MinSchemaFinding[] {
  const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
  return names
    .filter((n) => /^\d{14}_/.test(n) && n > min)
    .sort()
    .flatMap((name) => {
      const file = path.join(dir, name, 'migration.sql');
      if (!fs.existsSync(file) || NOT_REQUIRED_MARKER.test(fs.readFileSync(file, 'utf8'))) return [];
      return [
        {
          migration: name,
          message:
            `es posterior a FRONT_MIN_SCHEMA (${min}) y no dice si el front la necesita. Si el código de este release la necesita, sube FRONT_MIN_SCHEMA ` +
            `en lib/platform/min-schema.ts a "${name}"; si el front funciona sin ella, añade a la migración "-- front-min-schema: not-required <motivo>".`,
        },
      ];
    });
}

// Uso: npx tsx scripts/migration-lint.ts
if (process.argv[1] && path.basename(process.argv[1]) === 'migration-lint.ts') {
  const dir = path.join(process.cwd(), 'prisma', 'migrations');
  const problems = lintMigrationsDir(dir);
  const undecided = checkMinSchemaDecisions(dir);
  if (problems.length === 0 && undecided.length === 0) {
    console.log('Migraciones: todas las posteriores a la línea base son aditivas y la puerta de esquema está al día.');
  } else {
    for (const { migration, findings } of problems) {
      for (const f of findings) console.error(`✗ ${migration}: [${f.rule}] ${f.message}`);
    }
    for (const u of undecided) console.error(`✗ ${u.migration}: [front-min-schema] ${u.message}`);
    if (problems.length) {
      console.error(
        '\nUna migración debe ser aditiva (expand). Si de verdad tiene que ser destructiva, añade una línea ' +
          '"-- allow-destructive: <motivo>" y asegúrate de que ningún despliegue ejecuta ya el código antiguo.'
      );
    }
    process.exit(1);
  }
}
