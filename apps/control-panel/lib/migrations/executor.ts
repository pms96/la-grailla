import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
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
  /**
   * Plan B (`lockTimeoutMode: 'database'`): mientras corre `fn`, la BD ENTERA tiene `lock_timeout` (afecta también a las conexiones normales
   * del cliente) y después se restaura. Por defecto NO se usa: el `lock_timeout` va en la conexión del runner (`withConnectionLockTimeout`).
   */
  withLockTimeout<T>(directUrl: string, ms: number, fn: () => Promise<T>): Promise<T>;
}

/** Quita de un texto cualquier cadena de conexión (un error de driver podría reproducirla). */
export function redactUrls(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, 'postgresql://[oculto]');
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * La URL con un `lock_timeout` SOLO para la conexión que abre el motor de Prisma (`options=-c lock_timeout=…`, parámetro de arranque de
 * Postgres). A diferencia de `ALTER DATABASE … SET`, no toca la BD del cliente: ni sus conexiones normales (las de ventas y taquilla esperan
 * bloqueos de asesoramiento hasta 20 s y fallarían a los 3 s) ni queda nada que restaurar si el runner muere. Se comprobó que el motor de
 * Prisma lo respeta (la migración ve el valor en `current_setting`). Se codifica con %20 y %3D: un «+» no se leería como espacio.
 */
export function withConnectionLockTimeout(rawUrl: string, ms: number): string {
  const u = new URL(rawUrl);
  const existing = u.searchParams.get('options');
  u.searchParams.delete('options');
  const mine = `-c lock_timeout=${Math.max(1, Math.floor(ms))}`;
  const base = u.toString();
  return `${base}${base.includes('?') ? '&' : '?'}options=${encodeURIComponent(existing ? `${existing} ${mine}` : mine)}`;
}

async function withClient<T>(url: string, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasourceUrl: url, log: [] });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

/**
 * Resuelve un paquete desde el directorio del panel (su propio `node_modules`), no desde este archivo: así funciona igual bajo tsx y vitest.
 * En Vercel el directorio de trabajo puede ser la raíz del despliegue o la carpeta de la app: se prueban las dos.
 */
function resolveFromApp(find: (req: NodeJS.Require) => string): string {
  let last: unknown;
  for (const base of [process.cwd(), path.join(process.cwd(), 'apps', 'control-panel')]) {
    try {
      return find(createRequire(path.join(base, 'package.json')));
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

const appBases = () => [process.cwd(), path.join(process.cwd(), 'apps', 'control-panel')];

/**
 * Copia del CLI de Prisma y de todas sus dependencias que mete el build (scripts/bundle-migration-assets.js). En Vercel el rastreo de archivos
 * no llevaba `node_modules/prisma` a la función; esta copia vive en una carpeta de la propia app y sí llega. Solo se usa si falta el CLI normal.
 */
export function bundledModulesDir(): string | null {
  for (const base of appBases()) {
    const dir = path.join(base, 'migration-engine', 'modules');
    if (fs.existsSync(path.join(dir, 'prisma', 'build', 'index.js'))) return dir;
  }
  return null;
}

// Las rutas van literales en cada llamada (no como variable): así webpack no avisa de «dependencia con expresión» al compilar el panel.
function prismaBin(): string {
  try {
    return resolveFromApp((req) => req.resolve('prisma/build/index.js'));
  } catch (err) {
    const bundled = bundledModulesDir();
    if (bundled) return path.join(bundled, 'prisma', 'build', 'index.js');
    throw err;
  }
}

/** La carpeta de módulos empaquetados, solo si el CLI que se va a ejecutar es la copia (sus dependencias se buscan allí con NODE_PATH). */
function bundledCliDir(): string | null {
  const bundled = bundledModulesDir();
  try {
    return bundled && prismaBin().startsWith(bundled) ? bundled : null;
  } catch {
    return null;
  }
}

/** Solo lo que `prisma` necesita para arrancar: el resto del entorno del panel (SECRETS_KEYS, URLs de otras BD, PANEL_*) no se le pasa. */
const CHILD_ENV_ALLOW = /^(PATH|HOME|USER|TMPDIR|TEMP|TMP|LANG|LC_[A-Z_]+|TZ|SHELL|SYSTEMROOT|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|PRISMA_[A-Z_]+)$/;
export function childEnv(url: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(base)) if (v !== undefined && CHILD_ENV_ALLOW.test(k)) env[k] = v;
  return Object.assign(env, { DATABASE_URL: url, DIRECT_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' });
}

const isServerless = () => !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/** De los binarios `schema-engine-*` que trae `@prisma/engines`, el de esta plataforma (en Vercel, Linux con OpenSSL 3). */
export function pickSchemaEngine(names: string[], platform: string = process.platform): string | null {
  const engines = names.filter((n) => /^schema-engine-[a-z0-9.-]+$/i.test(n));
  const prefer = platform === 'linux' ? [/rhel-openssl-3/, /debian-openssl-3/, /linux/] : platform === 'darwin' ? [/darwin/] : [/windows/];
  for (const re of prefer) {
    const hit = engines.find((n) => re.test(n));
    if (hit) return hit;
  }
  return engines[0] ?? null;
}

export function schemaEngineSource(): string | null {
  const dirs: string[] = [];
  try {
    dirs.push(path.dirname(resolveFromApp((req) => req.resolve('@prisma/engines/package.json'))));
  } catch {
    // sin node_modules/@prisma/engines: se prueba la copia empaquetada
  }
  const bundled = bundledModulesDir();
  if (bundled) dirs.push(path.join(bundled, '@prisma', 'engines'));
  for (const dir of dirs) {
    try {
      const name = pickSchemaEngine(fs.readdirSync(dir));
      if (name) return path.join(dir, name);
    } catch {
      // carpeta ilegible: se sigue con la siguiente
    }
  }
  return null;
}

/**
 * En un entorno serverless (Vercel) el HOME no se puede escribir y un binario trazado puede perder el bit de ejecución: se copia el motor
 * de esquema a /tmp con permisos de ejecución y se le dice a Prisma dónde está. Fuera de ahí no se toca nada.
 */
export function engineEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const bundled = bundledCliDir();
  if (bundled) env.NODE_PATH = bundled;
  if (!isServerless()) return env;
  Object.assign(env, { HOME: os.tmpdir(), XDG_CACHE_HOME: os.tmpdir() });
  const src = schemaEngineSource();
  if (src) {
    const dest = path.join(os.tmpdir(), path.basename(src));
    try {
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        fs.chmodSync(dest, 0o755);
      }
      env.PRISMA_SCHEMA_ENGINE_BINARY = dest;
    } catch {
      // Sin copia, Prisma buscará el motor donde lo instaló npm: el diagnóstico dirá si funciona.
    }
  }
  return env;
}

function runPrisma(args: string[], url: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaBin(), ...args], {
      env: { ...childEnv(url), ...engineEnv() },
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

export type EngineDiagnosis = { ok: boolean; lines: string[] };

/**
 * ¿Puede ESTE entorno aplicar migraciones? Es lo que hay que saber antes de fiarse del botón «Migrar BD» en Vercel: encuentra la carpeta
 * `prisma/` del front, el CLI de Prisma y el motor de esquema, y ejecuta `prisma --version` y `prisma migrate status` (solo lectura) contra
 * la BD del cliente. No modifica nada. Nada de lo que devuelve contiene una URL de conexión.
 */
export async function diagnoseMigrationEngine(directUrl: string, { schemaPath, prismaDir }: { schemaPath: string; prismaDir: string }): Promise<EngineDiagnosis> {
  const lines: string[] = [];
  let ok = true;
  const bad = (line: string) => {
    ok = false;
    lines.push(`✗ ${line}`);
  };
  const good = (line: string) => lines.push(`✓ ${line}`);

  lines.push(`Entorno: ${isServerless() ? 'serverless' : 'local'} · Node ${process.version} · ${process.platform}-${process.arch}`);

  if (fs.existsSync(schemaPath)) {
    let count = 0;
    try {
      count = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((n) => /^\d{14}_/.test(n)).length;
    } catch {
      // sin carpeta de migraciones: se avisa abajo
    }
    count > 0 ? good(`Carpeta prisma del front encontrada (${count} migraciones)`) : bad('La carpeta prisma del front no trae migraciones (¿falta incluirla en el despliegue?)');
  } else {
    bad(`No se encuentra el schema.prisma del front (${path.relative(process.cwd(), prismaDir) || '.'})`);
  }

  try {
    prismaBin();
    good(`CLI de Prisma encontrado (${bundledCliDir() ? 'copia empaquetada por el build' : 'node_modules'})`);
  } catch {
    bad('No se encuentra el CLI de Prisma (paquete `prisma`) en este despliegue');
    // Dónde se ha buscado y qué hay, para poder corregirlo sin adivinar: en Vercel la raíz de la función no es la de la app.
    const has = (base: string, rel: string) => (fs.existsSync(path.join(base, rel)) ? 'sí' : 'no');
    for (const base of [...appBases(), ...(process.env.LAMBDA_TASK_ROOT ? [process.env.LAMBDA_TASK_ROOT] : [])]) {
      lines.push(`  · ${base}: node_modules ${has(base, 'node_modules')} · node_modules/prisma ${has(base, 'node_modules/prisma')} · migration-engine ${has(base, 'migration-engine')} · front-prisma ${has(base, 'front-prisma')}`);
    }
    return { ok, lines };
  }

  const engine = schemaEngineSource();
  engine ? good(`Motor de esquema incluido: ${path.basename(engine)}`) : bad('No se encuentra el binario schema-engine de @prisma/engines en este despliegue');

  try {
    const v = await runPrisma(['--version'], directUrl);
    const info = redactUrls(v.output)
      .split('\n')
      .filter((l) => /^(prisma\b|Computed binaryTarget|Schema Engine|Query Engine)/i.test(l.trim()))
      .map((l) => l.trim().replace(/\(at [^)]*\)/, '').slice(0, 110));
    v.code === 0 ? good(`prisma --version responde${info.length ? `: ${info.join(' · ')}` : ''}`) : bad(`prisma --version falla: ${redactUrls(v.output).slice(-200).trim()}`);
  } catch (err) {
    bad(`No se pudo lanzar el CLI de Prisma: ${redactUrls(err instanceof Error ? err.message : String(err))}`);
    return { ok, lines };
  }

  try {
    const s = await runPrisma(['migrate', 'status', '--schema', schemaPath], directUrl);
    const text = redactUrls(s.output);
    if (/up to date/i.test(text)) good('El motor llega a la BD del cliente: esquema al día');
    else if (/not yet been applied|have not yet been applied/i.test(text)) good('El motor llega a la BD del cliente: hay migraciones por aplicar');
    else if (/P100[01]|Can't reach database|Authentication failed/i.test(text)) bad(`El motor arranca pero no conecta con la BD del cliente: ${text.slice(-200).trim()}`);
    else bad(`prisma migrate status no dio un resultado reconocible: ${text.slice(-300).trim()}`);
  } catch (err) {
    bad(`No se pudo lanzar prisma migrate status: ${redactUrls(err instanceof Error ? err.message : String(err))}`);
  }
  return { ok, lines };
}
