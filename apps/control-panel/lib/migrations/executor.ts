import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/* Ejecutor de migraciones sobre la BD de UN cliente: el motor de Prisma (`prisma migrate deploy`, el mismo `schema-engine` que usa
 * `migrate deploy` de siempre) más lo que Prisma no da: un `lock_timeout` para que una migración que espera un bloqueo no deje en
 * cola a todo el tráfico del cliente, y la recuperación de una migración abortada por ese motivo.
 *
 * La URL de la BD viaja SIEMPRE por entorno (nunca por argv, que queda en `ps` y en el historial) y nada de lo que se devuelve la
 * contiene. */

export type TenantDbState = {
  /** Terminadas y no revertidas. */
  applied: string[];
  /** Iniciadas y sin terminar ni revertir: Prisma se niega a seguir hasta resolverlas (P3009). */
  failed: string[];
};

export type DeployOutcome =
  | { ok: true }
  | { ok: false; kind: 'lock_timeout' | 'failed'; migration: string | null; message: string };

export interface MigrationExecutor {
  inspect(directUrl: string): Promise<TenantDbState>;
  deploy(directUrl: string, opts: { schemaPath: string }): Promise<DeployOutcome>;
  /** Marca como revertida una migración abortada (ya deshecha por Postgres) para poder reintentarla. */
  resolveRolledBack(directUrl: string, migration: string, opts: { schemaPath: string }): Promise<void>;
  /** Mientras corre `fn`, la BD tiene `lock_timeout`; después se restaura el valor anterior. */
  withLockTimeout<T>(directUrl: string, ms: number, fn: () => Promise<T>): Promise<T>;
}

/** Quita de un texto cualquier cadena de conexión (un error de driver podría reproducirla). */
export function redactUrls(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, 'postgresql://[oculto]');
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function withClient<T>(url: string, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasourceUrl: url, log: [] });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

function prismaBin(): string {
  // Se resuelve desde el directorio del panel (su propio `prisma`), no desde este archivo: así funciona igual bajo tsx y vitest.
  const req = createRequire(path.join(process.cwd(), 'package.json'));
  return req.resolve('prisma/build/index.js');
}

/** Solo lo que `prisma` necesita para arrancar: el resto del entorno del panel (SECRETS_KEYS, URLs de otras BD, PANEL_*) no se le pasa. */
const CHILD_ENV_ALLOW = /^(PATH|HOME|USER|TMPDIR|TEMP|TMP|LANG|LC_[A-Z_]+|TZ|SHELL|SYSTEMROOT|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|PRISMA_[A-Z_]+)$/;
export function childEnv(url: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(base)) if (v !== undefined && CHILD_ENV_ALLOW.test(k)) env[k] = v;
  return Object.assign(env, { DATABASE_URL: url, DIRECT_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' });
}

function runPrisma(args: string[], url: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaBin(), ...args], {
      env: childEnv(url),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

export const prismaExecutor: MigrationExecutor = {
  async inspect(directUrl) {
    return withClient(directUrl, async (db) => {
      const [{ exists }] = await db.$queryRawUnsafe<{ exists: boolean }[]>(`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`);
      if (!exists) return { applied: [], failed: [] };
      const rows = await db.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>(
        'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name'
      );
      return {
        applied: [...new Set(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name))],
        failed: [...new Set(rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name))],
      };
    });
  },

  async deploy(directUrl, { schemaPath }) {
    const { code, output } = await runPrisma(['migrate', 'deploy', '--schema', schemaPath], directUrl);
    if (code === 0) return { ok: true };
    const migration = /Migration name:\s*(\S+)/.exec(output)?.[1] ?? null;
    // 55P03 = lock_not_available: Postgres abortó la sentencia por el lock_timeout y deshizo la migración entera.
    const kind = /Database error code:\s*55P03/.test(output) ? 'lock_timeout' : 'failed';
    return { ok: false, kind, migration, message: redactUrls(output).slice(-1500) };
  },

  async resolveRolledBack(directUrl, migration, { schemaPath }) {
    const { code, output } = await runPrisma(['migrate', 'resolve', '--rolled-back', migration, '--schema', schemaPath], directUrl);
    if (code !== 0) throw new Error(`No se pudo marcar como revertida la migración ${migration}: ${redactUrls(output).slice(-400)}`);
  },

  async withLockTimeout(directUrl, ms, fn) {
    // `ALTER DATABASE … SET` afecta a las conexiones NUEVAS (las que abre el motor de Prisma) sea cual sea el driver; hace falta ser
    // el propietario de la BD, como lo es el rol de cada cliente.
    const { db: dbName, previous } = await withClient(directUrl, async (db) => {
      const [{ name }] = await db.$queryRawUnsafe<{ name: string }[]>('SELECT current_database() AS name');
      const prev = await db.$queryRawUnsafe<{ setconfig: string[] }[]>(
        `SELECT setconfig FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setrole = 0`
      );
      const entry = prev[0]?.setconfig?.find((c) => c.startsWith('lock_timeout='));
      const mine = `${Math.max(1, Math.floor(ms))}ms`;
      let previousValue = entry ? entry.slice('lock_timeout='.length) : null;
      // Un valor igual al que vamos a poner es casi seguro el resto de un runner que murió antes de restaurar: «restaurarlo» lo haría
      // permanente. Se trata como si no hubiera ninguno.
      if (previousValue === mine) previousValue = null;
      await db.$executeRawUnsafe(`ALTER DATABASE ${quoteIdent(name)} SET lock_timeout = '${mine}'`);
      return { db: name, previous: previousValue };
    });
    try {
      return await fn();
    } finally {
      // Si restaurar falla NO se tapa el resultado de la migración (que ya se aplicó o falló por sus motivos): se avisa y se sigue.
      try {
        await withClient(directUrl, async (db) => {
          if (previous === null) await db.$executeRawUnsafe(`ALTER DATABASE ${quoteIdent(dbName)} RESET lock_timeout`);
          else await db.$executeRawUnsafe(`ALTER DATABASE ${quoteIdent(dbName)} SET lock_timeout = '${previous.replace(/'/g, "''")}'`);
        });
      } catch (err) {
        console.error(`[migraciones] No se pudo restaurar lock_timeout en ${dbName}: ${redactUrls(err instanceof Error ? err.message : String(err))}. Comprueba pg_db_role_setting.`);
      }
    }
  },
};
