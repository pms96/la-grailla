import type { Prisma, TenantStatus } from '@prisma/client';
import { newUlid } from '@grailla/contracts';
import type { ActingOperator } from '../actor';
import { appendAudit } from '../audit';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import { sealField } from '../secrets-store';
import { claimDomain, parseHostOrThrow } from './domains';
import { ServiceError } from './errors';

export const DB_URL_POOLED_FIELD = 'db_url_pooled';
export const DB_URL_DIRECT_FIELD = 'db_url_direct';

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
  return [...new Set([...core, ...requested])].sort();
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
  const tenantId = newUlid(now);
  const [pooledEnc, directEnc] = await Promise.all([
    sealField(pooled, { scope: tenantId, field: DB_URL_POOLED_FIELD }),
    sealField(direct, { scope: tenantId, field: DB_URL_DIRECT_FIELD }),
  ]);

  return prisma.$transaction(async (tx) => {
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
}

/** Sustituye la lista de módulos (el núcleo no se puede quitar). */
export async function setModules(subscriptionId: string, requested: string[], actor: ActingOperator) {
  assertCan(actor.role, 'tenants:write');
  return prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { id: subscriptionId }, include: { modules: true } });
    if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
    const wanted = await resolveModules(tx, sub.productKey, requested);
    const current = sub.modules.map((m) => m.moduleKey);
    const added = wanted.filter((m) => !current.includes(m));
    const removed = current.filter((m) => !wanted.includes(m));
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
      meta: { added, removed },
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
  actor: ActingOperator
) {
  assertCan(actor.role, 'database:write');
  const pooled = parseDatabaseUrl(urls.pooled, 'URL de BD (pooled)');
  const direct = parseDatabaseUrl(urls.direct, 'URL de BD (directa)');
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
  const [pooledEnc, directEnc] = await Promise.all([
    sealField(pooled, { scope: sub.tenantId, field: DB_URL_POOLED_FIELD }),
    sealField(direct, { scope: sub.tenantId, field: DB_URL_DIRECT_FIELD }),
  ]);
  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        dbUrlPooledEnc: pooledEnc,
        dbUrlDirectEnc: directEnc,
        ...(urls.schemaVersion !== undefined ? { schemaVersion: urls.schemaVersion } : {}),
      },
    });
    await appendAudit(tx, { actor, action: 'subscription.replace_database_urls', targetType: 'subscription', targetId: subscriptionId, tenantId: sub.tenantId, meta: {} });
  });
}
