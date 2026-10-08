import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DB_URL_POOLED_FIELD } from '@grailla/contracts';
import { decryptSecret } from '@/lib/secrets';
import type { TenantContext } from './context';
import { TenantContextError } from './context';

/* Un PrismaClient por cliente, creado de forma síncrona a partir del contexto de la petición.
 *
 * Medido en el spike M1: con el motor librería de Prisma 6.7, un cliente extra cuesta ~1,2 MB en reposo y no hace falta subir
 * Prisma ni usar adapters. Cada cliente abre su propio pool, así que se limita `connection_limit` (mínimo 3: dentro de una
 * transacción interactiva hace falta una segunda conexión si alguien usa el `prisma` global en vez de `tx`) y se expulsan
 * por INACTIVIDAD, no por número (crear/cerrar clientes en bucle crece lento pero crece). */

export const CLIENT_IDLE_MS = 10 * 60_000;
const MIN_IDLE_BEFORE_EVICT_MS = 60_000;
const SOFT_MAX_CLIENTS = 24;

type Entry = { client: unknown; lastUsed: number; urlHash: string };
const g = globalThis as unknown as { __grailla_tenant_clients?: Map<string, Entry> };
const clients = (g.__grailla_tenant_clients ??= new Map<string, Entry>());

function withPoolLimits(url: string): string {
  const u = new URL(url);
  if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', process.env.TENANT_DB_CONNECTION_LIMIT || '3');
  if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', '10');
  return u.toString();
}

/** URL de BD del cliente en claro. Solo vive en memoria del proceso. */
export function resolveDatabaseUrl(ctx: TenantContext): string {
  if (ctx.testDbUrl) {
    if (!process.env.VITEST) throw new TenantContextError('testDbUrl solo se admite en tests');
    return ctx.testDbUrl;
  }
  return decryptSecret(ctx.db.pooledEnc, { tenantId: ctx.tenantId, configKey: DB_URL_POOLED_FIELD });
}

function evictIdle(now: number): void {
  for (const [key, e] of clients) {
    const idle = now - e.lastUsed;
    if (idle > CLIENT_IDLE_MS || (clients.size > SOFT_MAX_CLIENTS && idle > MIN_IDLE_BEFORE_EVICT_MS)) {
      clients.delete(key);
      void (e.client as PrismaClient).$disconnect().catch(() => undefined);
    }
  }
}

/** `build` recibe un PrismaClient base y devuelve el cliente extendido que usa la app (extensión de Decimal → number). */
export function tenantClient<T>(ctx: TenantContext, build: (base: PrismaClient) => T): T {
  const now = Date.now();
  const url = resolveDatabaseUrl(ctx);
  const urlHash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  const hit = clients.get(ctx.tenantId);
  if (hit && hit.urlHash === urlHash) {
    hit.lastUsed = now;
    return hit.client as T;
  }
  // La URL cambió (rotación de BD en el panel) o no hay cliente: se crea uno nuevo y se cierra el antiguo.
  if (hit) void (hit.client as PrismaClient).$disconnect().catch(() => undefined);
  evictIdle(now);
  const client = build(new PrismaClient({ datasources: { db: { url: withPoolLimits(url) } } }));
  clients.set(ctx.tenantId, { client, lastUsed: now, urlHash });
  return client;
}

/** Solo tests. */
export async function disconnectAllTenantClients(): Promise<void> {
  const all = [...clients.values()];
  clients.clear();
  await Promise.all(all.map((e) => (e.client as PrismaClient).$disconnect().catch(() => undefined)));
}
