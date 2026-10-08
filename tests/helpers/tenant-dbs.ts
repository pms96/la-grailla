import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { isLocalDatabaseUrl } from '@/scripts/is-local-database-url';
import { runWithTenant, type TenantContext } from '@/lib/tenant/context';

/* Arnés de dos bases de datos para los tests de aislamiento entre clientes.
 *
 * El resto de la suite golpea la BD de desarrollo. Los tests de "dos clientes
 * en el mismo despliegue" necesitan dos esquemas reales e independientes (A y
 * B), con el esquema de producción aplicado por las migraciones reales.
 *
 * Salvaguardas — este archivo crea y VACÍA bases de datos:
 *  - solo trabaja contra un servidor local (localhost / 127.0.0.1);
 *  - solo toca bases cuyo nombre empieza por `lagrailla_test_`, así que nunca
 *    puede vaciar la BD de desarrollo ni una remota por un DATABASE_URL mal
 *    apuntado. */

export const TEST_DB_PREFIX = 'lagrailla_test_';
export type TenantSlot = 'a' | 'b';
const SLOTS: TenantSlot[] = ['a', 'b'];

export function testDatabaseName(slot: TenantSlot): string {
  return `${TEST_DB_PREFIX}${slot}`;
}

function baseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL no está definido: el arnés de dos BDs necesita un servidor Postgres local');
  if (!isLocalDatabaseUrl(raw)) {
    throw new Error('El arnés de dos BDs solo funciona contra un Postgres local (DATABASE_URL no es localhost/127.0.0.1)');
  }
  return new URL(raw);
}

function withDatabase(url: URL, database: string): string {
  const u = new URL(url.toString());
  u.pathname = `/${database}`;
  return u.toString();
}

export function assertSafeTestDatabase(databaseUrl: string): void {
  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new Error('Base de datos no local: el arnés se niega a operar sobre ella');
  }
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!name.startsWith(TEST_DB_PREFIX)) {
    throw new Error(`Base de datos "${name}" no empieza por "${TEST_DB_PREFIX}": el arnés se niega a operar sobre ella`);
  }
}

export function testDatabaseUrl(slot: TenantSlot): string {
  const url = withDatabase(baseUrl(), testDatabaseName(slot));
  assertSafeTestDatabase(url);
  return url;
}

const clients = new Map<string, PrismaClient>();

function clientFor(url: string): PrismaClient {
  let client = clients.get(url);
  if (!client) {
    client = new PrismaClient({ datasources: { db: { url } } });
    clients.set(url, client);
  }
  return client;
}

/** Cliente Prisma de la BD de test del hueco indicado. Llama antes a ensureTenantDatabases(). */
export function tenantClient(slot: TenantSlot): PrismaClient {
  return clientFor(testDatabaseUrl(slot));
}

function migrationCount(): number {
  const dir = path.join(process.cwd(), 'prisma', 'migrations');
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

async function isUpToDate(client: PrismaClient): Promise<boolean> {
  try {
    const rows = await client.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
    );
    return Number(rows[0]?.n ?? 0) === migrationCount();
  } catch {
    return false; // la tabla aún no existe
  }
}

let ensured: Promise<void> | null = null;

/** Crea las dos BDs si faltan y aplica las migraciones reales. Idempotente y memoizado por proceso. */
export function ensureTenantDatabases(): Promise<void> {
  ensured ??= (async () => {
    const base = baseUrl();
    const admin = clientFor(withDatabase(base, 'postgres'));
    for (const slot of SLOTS) {
      const name = testDatabaseName(slot);
      const exists = await admin.$queryRawUnsafe<{ ok: number }[]>('SELECT 1 AS ok FROM pg_database WHERE datname = $1', name);
      if (exists.length === 0) {
        // El nombre sale de una constante (prefijo + 'a'|'b'), nunca de entrada externa.
        await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      }
      const url = testDatabaseUrl(slot);
      if (!(await isUpToDate(clientFor(url)))) {
        execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
          env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
          stdio: 'pipe',
        });
      }
    }
  })();
  return ensured;
}

/** Vacía todas las tablas de la BD de test (conserva el historial de migraciones). */
export async function resetTenantDatabase(slot: TenantSlot): Promise<void> {
  const url = testDatabaseUrl(slot); // valida local + prefijo
  const client = clientFor(url);
  const tables = await client.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename.replace(/"/g, '""')}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function disconnectTenantClients(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.$disconnect()));
  clients.clear();
  ensured = null;
}

export const TEST_TENANT_IDS: Record<TenantSlot, string> = {
  a: '01HF7YAT00AAAAAAAAAAAAAAAA',
  b: '01HF7YAT00BBBBBBBBBBBBBBBB',
};

/** Contexto de cliente de pruebas: apunta a la BD de test del hueco indicado (`testDbUrl` solo funciona bajo Vitest). */
export function testTenantContext(slot: TenantSlot, over: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: TEST_TENANT_IDS[slot],
    product: 'grailla',
    host: `${slot}.cliente.test`,
    primaryDomain: `${slot}.cliente.es`,
    epoch: 0,
    status: 'ACTIVE',
    modules: ['nucleo'],
    db: { pooledEnc: 'enc:v2:tk:AAAA:AAAA:AAAA', directEnc: 'enc:v2:tk:AAAA:AAAA:AAAA' },
    testDbUrl: testDatabaseUrl(slot),
    ...over,
  };
}

/** Ejecuta `fn` como si la petición viniera del cliente A o B (el `prisma` global se resuelve a su BD). Requiere PLATFORM_MODE=on. */
export function withTenantForTest<T>(slot: TenantSlot, fn: () => T, over: Partial<TenantContext> = {}): T {
  return runWithTenant(testTenantContext(slot, over), fn);
}
