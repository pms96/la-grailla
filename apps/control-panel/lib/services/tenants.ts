import type { Prisma, TenantStatus } from '@prisma/client';
import { newUlid } from '@grailla/contracts';
import type { ActingOperator } from '../actor';
import { appendAudit } from '../audit';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import { openField, sealField } from '../secrets-store';
import { assertSameDatabase, databaseFingerprint } from './db-identity';
import { claimDomain, parseHostOrThrow } from './domains';
import { ServiceError } from './errors';
import { GUARDED_MODULES, checkModuleRemoval } from './module-guards';
import type { FetchLike } from './tenant-calls';
import { readTenantMarker } from './tenant-db';

export const DB_URL_POOLED_FIELD = 'db_url_pooled';
export const DB_URL_DIRECT_FIELD = 'db_url_direct';

const isUniqueViolation = (err: unknown, field: string): boolean => {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  return e?.code === 'P2002' && String(e.meta?.target ?? '').includes(field);
};
const databaseInUse = () => new ServiceError('database_in_use', 'Esa base de datos ya está registrada en otro cliente: cada cliente tiene la suya. Revisa las URLs (¿has copiado las de otro proyecto de Neon?)');

/**
 * Las altas anteriores a la huella no la tienen: se calcula abriendo su URL. Así una BD ya en uso se detecta aunque el cliente que la usa
 * se diera de alta antes. Si dos clientes antiguos ya comparten BD, el segundo se queda sin huella y se avisa (hay que corregirlo a mano).
 */
async function backfillFingerprints(): Promise<void> {
  // Los clientes retirados no tienen URL (se vaciaron) ni huella a propósito: no hay nada que calcular.
  const rows = await prisma.subscription.findMany({ where: { dbFingerprint: null, tenant: { status: { not: 'DELETED' } } }, select: { id: true, tenantId: true, dbUrlDirectEnc: true } });
  for (const r of rows) {
    try {
      const url = await openField(r.dbUrlDirectEnc, { scope: r.tenantId, field: DB_URL_DIRECT_FIELD });
      await prisma.subscription.update({ where: { id: r.id }, data: { dbFingerprint: databaseFingerprint(url) } });
    } catch (err) {
      console.error(`[tenants] no se pudo calcular la huella de BD del cliente ${r.tenantId}${isUniqueViolation(err, 'dbFingerprint') ? ': comparte BD con otro cliente' : ''}`);
    }
  }
}

/** Falla si otra suscripción (distinta de `except`) ya usa esa BD. */
async function assertDatabaseFree(fingerprint: string, except?: string): Promise<void> {
  await backfillFingerprints();
  const other = await prisma.subscription.findFirst({ where: { dbFingerprint: fingerprint, ...(except ? { id: { not: except } } : {}) }, select: { id: true } });
  if (other) throw databaseInUse();
}

export function parseDatabaseUrl(raw: string, label: string): string {
  const value = (raw ?? '').trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceError('invalid_database_url', `${label}: no es una URL válida`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new ServiceError('invalid_database_url', `${label}: debe ser una URL postgresql://`);
  }
  // Fuera de localhost la conexión debe ir cifrada: las credenciales de un cliente no viajan en claro.
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const ssl = url.searchParams.get('sslmode');
  if (!local && !['require', 'verify-ca', 'verify-full'].includes(ssl ?? '')) {
    throw new ServiceError('insecure_database_url', `${label}: una base de datos remota debe usar sslmode=require (o verify-full)`);
  }
  return value;
}

export type CreateTenantInput = {
  name: string;
  productKey: string;
  primaryHost: string;
  modules: string[];
  dbUrlPooled: string;
  dbUrlDirect: string;
  schemaVersion?: string | null;
  dbRegion?: string | null;
  cell?: string;
};

/** Valida los módulos contra el catálogo del producto; el núcleo siempre se incluye. */
async function resolveModules(tx: Prisma.TransactionClient, productKey: string, requested: string[]): Promise<string[]> {
  const defs = await tx.moduleDef.findMany({ where: { productKey } });
  if (defs.length === 0) throw new ServiceError('unknown_product', 'Producto desconocido');
  const known = new Set(defs.map((d) => d.key));
  const unknown = requested.filter((m) => !known.has(m));
  if (unknown.length) throw new ServiceError('unknown_module', `Módulo desconocido para este producto: ${unknown.join(', ')}`);
  const core = defs.filter((d) => d.isCore).map((d) => d.key);
  const wanted = [...new Set([...core, ...requested])].sort();
  // Wallets solo emite pases de entradas: sin Entradas sería un producto cobrado que no funciona (el front lo ignoraría igualmente).
  if (wanted.includes('wallets') && !wanted.includes('entradas')) throw new ServiceError('module_requires', 'Wallets necesita el módulo Entradas');
  return wanted;
}

export async function createTenant(input: CreateTenantInput, actor: ActingOperator, now: number = Date.now()) {
  // Dar de alta un cliente fija a qué base de datos apunta: es tan sensible como sustituir sus credenciales.
  assertCan(actor.role, 'tenants:write');
  assertCan(actor.role, 'database:write');
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new ServiceError('invalid_name', 'El nombre debe tener entre 2 y 120 caracteres');
  const host = parseHostOrThrow(input.primaryHost);
  const pooled = parseDatabaseUrl(input.dbUrlPooled, 'URL de BD (pooled)');
  const direct = parseDatabaseUrl(input.dbUrlDirect, 'URL de BD (directa)');
  assertSameDatabase(pooled, direct);
  const dbFingerprint = databaseFingerprint(direct);
  await assertDatabaseFree(dbFingerprint);
  const tenantId = newUlid(now);
  const [pooledEnc, directEnc] = await Promise.all([
    sealField(pooled, { scope: tenantId, field: DB_URL_POOLED_FIELD }),
    sealField(direct, { scope: tenantId, field: DB_URL_DIRECT_FIELD }),
  ]);

  try {
    return await prisma.$transaction(async (tx) => {
      const modules = await resolveModules(tx, input.productKey, input.modules);
      const tenant = await tx.tenant.create({ data: { id: tenantId, name } });
      const sub = await tx.subscription.create({
        data: {
          tenantId,
          productKey: input.productKey,
          cell: input.cell ?? 'shared-1',
          schemaVersion: input.schemaVersion ?? null,
          dbRegion: input.dbRegion ?? null,
          dbUrlPooledEnc: pooledEnc,
          dbUrlDirectEnc: directEnc,
          dbFingerprint,
          modules: { create: modules.map((moduleKey) => ({ moduleKey, enabledBy: actor.id })) },
        },
      });
      const domain = await claimDomain(tx, { host, subscriptionId: sub.id, tenantId }, now);
      await appendAudit(tx, {
        actor,
        action: 'tenant.create',
        targetType: 'tenant',
        targetId: tenantId,
        tenantId,
        meta: { name, productKey: input.productKey, host, modules, cell: sub.cell },
      });
      return { tenant, subscription: sub, domain };
    });
  } catch (err) {
    // Dos altas simultáneas con la misma BD: la comprobación de arriba no las ve a la vez, el índice único sí.
    if (isUniqueViolation(err, 'dbFingerprint')) throw databaseInUse();
    throw err;
  }
}

export const MIN_OVERRIDE_REASON = 10;

/**
 * Sustituye la lista de módulos (el núcleo no se puede quitar).
 *
 * Quitar Entradas o Tienda (P1-20) se comprueba ANTES contra la salud del cliente: con pedidos pendientes, eventos por venir con entradas
 * vendidas o pedidos de tienda sin enviar, se niega. `override.reason` anula la guarda (también cuando no se puede comprobar) y queda en la
 * auditoría con lo que se asumió. La comprobación va fuera de la transacción: es una llamada de red y la transacción caduca a los 5 s.
 */
export async function setModules(
  subscriptionId: string,
  requested: string[],
  actor: ActingOperator,
  opts: { override?: { reason: string }; healthFetch?: FetchLike } = {}
) {
  assertCan(actor.role, 'tenants:write');
  const pre = await prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { modules: true, domains: true } });
  if (!pre) throw new ServiceError('not_found', 'Suscripción no encontrada');
  const preWanted = await resolveModules(prisma, pre.productKey, requested);
  const preRemoved = pre.modules.map((m) => m.moduleKey).filter((m) => !preWanted.includes(m));
  const check = await checkModuleRemoval(pre, preRemoved, { healthFetch: opts.healthFetch });
  const open = check.blockers.length > 0 || check.unverified !== null;
  const reason = opts.override?.reason.trim() ?? '';
  if (open && !reason) {
    const why = check.blockers.length ? `hay obligaciones abiertas (${check.blockers.join('; ')})` : check.unverified;
    throw new ServiceError(
      'module_obligations',
      `No se apaga ${preRemoved.filter((m) => GUARDED_MODULES.includes(m)).join(' y ')}: ${why}. Espera a que se resuelvan o, si es imprescindible, apágalo indicando el motivo (queda en la auditoría).`
    );
  }
  if (open && reason.length < MIN_OVERRIDE_REASON) {
    throw new ServiceError('override_reason_required', `El motivo de la anulación debe tener al menos ${MIN_OVERRIDE_REASON} caracteres`);
  }
  return prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { id: subscriptionId }, include: { modules: true } });
    if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
    const wanted = await resolveModules(tx, sub.productKey, requested);
    const current = sub.modules.map((m) => m.moduleKey);
    const added = wanted.filter((m) => !current.includes(m));
    const removed = current.filter((m) => !wanted.includes(m));
    // Alguien cambió los módulos mientras se comprobaba: lo comprobado ya no es lo que se va a quitar.
    if (removed.some((m) => GUARDED_MODULES.includes(m) && !preRemoved.includes(m))) {
      throw new ServiceError('conflict', 'Los módulos cambiaron mientras se comprobaban los pedidos; repite la operación');
    }
    if (added.length === 0 && removed.length === 0) return { added, removed };
    if (removed.length) await tx.subscriptionModule.deleteMany({ where: { subscriptionId, moduleKey: { in: removed } } });
    if (added.length) {
      await tx.subscriptionModule.createMany({ data: added.map((moduleKey) => ({ subscriptionId, moduleKey, enabledBy: actor.id })) });
    }
    await appendAudit(tx, {
      actor,
      action: 'subscription.set_modules',
      targetType: 'subscription',
      targetId: subscriptionId,
      tenantId: sub.tenantId,
      // Con guarda anulada queda quién asumió qué: el motivo, las obligaciones que había y si ni siquiera se pudo comprobar.
      meta: open ? { added, removed, override: { reason, blockers: check.blockers, unverified: check.unverified } } : { added, removed },
    });
    return { added, removed };
  });
}

/** Suspender o reactivar un cliente (el borrado definitivo no se ofrece en esta versión). */
export async function setTenantStatus(tenantId: string, status: Extract<TenantStatus, 'ACTIVE' | 'SUSPENDED'>, actor: ActingOperator) {
  assertCan(actor.role, 'tenants:write');
  return prisma.$transaction(async (tx) => {
    const t = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!t) throw new ServiceError('not_found', 'Cliente no encontrado');
    if (t.status === 'PENDING_DELETION' || t.status === 'DELETED') throw new ServiceError('invalid_state', 'Este cliente está en borrado');
    if (t.status === status) return t;
    const updated = await tx.tenant.update({ where: { id: tenantId }, data: { status } });
    await appendAudit(tx, { actor, action: 'tenant.set_status', targetType: 'tenant', targetId: tenantId, tenantId, meta: { from: t.status, to: status } });
    return updated;
  });
}

/** Sube la época: tras publicar, invalida de golpe sesiones y tokens de este cliente. */
export async function bumpEpoch(subscriptionId: string, actor: ActingOperator) {
  assertCan(actor.role, 'tenants:write');
  return prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.update({ where: { id: subscriptionId }, data: { epoch: { increment: 1 } } });
    await appendAudit(tx, {
      actor,
      action: 'subscription.bump_epoch',
      targetType: 'subscription',
      targetId: subscriptionId,
      tenantId: sub.tenantId,
      meta: { epoch: sub.epoch },
    });
    return sub;
  });
}

/** Cambia las URLs de la BD del cliente (solo SUPERADMIN). Nunca se registran en la auditoría. */
export async function replaceDatabaseUrls(
  subscriptionId: string,
  urls: { pooled: string; direct: string; schemaVersion?: string | null },
  actor: ActingOperator,
  /** `checkMarker`: abre la BD nueva y comprueba que no está marcada como de OTRO cliente (necesita alcanzarla; la acción del panel lo pide). */
  opts: { checkMarker?: boolean } = {}
) {
  assertCan(actor.role, 'database:write');
  const pooled = parseDatabaseUrl(urls.pooled, 'URL de BD (pooled)');
  const direct = parseDatabaseUrl(urls.direct, 'URL de BD (directa)');
  assertSameDatabase(pooled, direct);
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
  const dbFingerprint = databaseFingerprint(direct);
  await assertDatabaseFree(dbFingerprint, subscriptionId);
  if (opts.checkMarker) {
    const marker = await readTenantMarker(direct);
    if (marker && marker !== sub.tenantId) {
      throw new ServiceError('database_belongs_to_other_tenant', `Esa base de datos pertenece a otro cliente (${marker}): no se puede asignar a este`);
    }
  }
  const [pooledEnc, directEnc] = await Promise.all([
    sealField(pooled, { scope: sub.tenantId, field: DB_URL_POOLED_FIELD }),
    sealField(direct, { scope: sub.tenantId, field: DB_URL_DIRECT_FIELD }),
  ]);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          dbUrlPooledEnc: pooledEnc,
          dbUrlDirectEnc: directEnc,
          dbFingerprint,
          ...(urls.schemaVersion !== undefined ? { schemaVersion: urls.schemaVersion } : {}),
        },
      });
      await appendAudit(tx, { actor, action: 'subscription.replace_database_urls', targetType: 'subscription', targetId: subscriptionId, tenantId: sub.tenantId, meta: {} });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'dbFingerprint')) throw databaseInUse();
    throw err;
  }
}
