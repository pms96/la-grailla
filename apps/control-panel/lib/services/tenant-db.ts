import { PrismaClient } from '@prisma/client';
import { ServiceError } from './errors';

/* Acceso del panel a la BD de UN cliente (alta, comprobaciones). Conexión corta con la URL directa; nunca se deja abierta. */

/** Clave de AppConfig con el id del cliente al que pertenece la BD. Se escribe al sembrar y el front la devuelve en su salud: si no coincide
 * con el cliente que lo sirve, esa BD es de OTRO cliente. No es un secreto. */
export const TENANT_MARKER_KEY = 'platform_tenant_id';
export const TENANT_MARKER_GROUP = 'platform';

export async function withTenantDb<T>(url: string, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasourceUrl: url, log: [] });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

async function tableExists(db: PrismaClient, table: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT to_regclass('public."${table}"') IS NOT NULL AS ok`);
  return rows[0]?.ok === true;
}

/** Id del cliente que dice esta BD, o null (sin marca o sin esquema todavía). */
export async function readTenantMarker(url: string): Promise<string | null> {
  return withTenantDb(url, async (db) => {
    if (!(await tableExists(db, 'AppConfig'))) return null;
    const rows = await db.$queryRawUnsafe<{ value: string }[]>(`SELECT "value" FROM "AppConfig" WHERE "key" = $1`, TENANT_MARKER_KEY);
    return rows[0]?.value?.trim() || null;
  });
}

/** Escribe la marca (no pisa una existente) y devuelve la que quede. Requiere el esquema ya migrado. */
export async function writeTenantMarker(url: string, tenantId: string, newId: () => string): Promise<string> {
  return withTenantDb(url, async (db) => {
    await db.$executeRawUnsafe(
      `INSERT INTO "AppConfig" ("id", "key", "value", "label", "group") VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("key") DO NOTHING`,
      newId(),
      TENANT_MARKER_KEY,
      tenantId,
      'Cliente de la plataforma',
      TENANT_MARKER_GROUP
    );
    const rows = await db.$queryRawUnsafe<{ value: string }[]>(`SELECT "value" FROM "AppConfig" WHERE "key" = $1`, TENANT_MARKER_KEY);
    return rows[0].value;
  });
}

export type DatabaseContents = { users: number; orders: number; shopOrders: number; events: number };

/** Cuántos datos de negocio tiene ya la BD (0 si aún no tiene esquema). Una BD con datos no es de un alta nueva. */
export async function databaseContents(url: string): Promise<DatabaseContents> {
  return withTenantDb(url, async (db) => {
    const count = async (table: string) => {
      if (!(await tableExists(db, table))) return 0;
      const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM "${table}"`);
      return Number(rows[0]?.n ?? 0);
    };
    return { users: await count('User'), orders: await count('Order'), shopOrders: await count('ShopOrder'), events: await count('Event') };
  });
}

/**
 * ¿Se puede dar de alta un cliente en esta BD? Se comprueba ANTES de registrar, migrar o sembrar nada:
 *  - con la marca de OTRO cliente: nunca (ni con `adopt`);
 *  - con la marca de este mismo cliente: sí (repetir un alta);
 *  - sin marca y sin datos de negocio: sí (BD nueva);
 *  - sin marca y con datos: solo con `adopt` (adoptar a propósito una BD que ya existía, p. ej. un cliente anterior a la plataforma).
 */
export async function assertProvisionTarget(url: string, expectedTenantId: string | null, adopt: boolean): Promise<{ marker: string | null; contents: DatabaseContents }> {
  const marker = await readTenantMarker(url);
  const contents = await databaseContents(url);
  if (marker) {
    if (marker !== expectedTenantId) {
      throw new ServiceError('database_belongs_to_other_tenant', `Esa base de datos ya pertenece a otro cliente (${marker}): no se puede usar para este. Comprueba que has copiado las URLs del proyecto de Neon correcto`);
    }
    return { marker, contents };
  }
  const total = contents.users + contents.orders + contents.shopOrders + contents.events;
  if (total > 0 && !adopt) {
    throw new ServiceError(
      'database_not_empty',
      `Esa base de datos ya tiene datos (${contents.users} usuarios, ${contents.orders + contents.shopOrders} pedidos, ${contents.events} eventos) y no está marcada como de ningún cliente. Un alta nueva necesita una BD vacía. Si de verdad quieres adoptarla, repite con --adopt-database`
    );
  }
  return { marker, contents };
}
