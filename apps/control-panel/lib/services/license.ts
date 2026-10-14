import crypto from 'node:crypto';
import type { Prisma, Subscription } from '@prisma/client';
import { licensePhase, registryKeyForRevocation, type LicenseState } from '@grailla/contracts';
import type { ActingOperator } from '../actor';
import { appendAudit } from '../audit';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import { getRegistryStore, type RegistryStore } from '../registry/store';
import { ServiceError } from './errors';
import { publishSubscription } from './snapshot';

/* Licencia por fases, claves canjeables, revocación de emergencia y refresco periódico de snapshots. */

const DAY_MS = 86_400_000;

export type LicenseTermsInput = { paidThrough: Date | null; graceDays: number; panelBlockedDays: number };

/** Fase de licencia de una suscripción en un instante (misma función pura que usa el front). */
export function licenseStateOf(sub: Pick<Subscription, 'paidThrough' | 'graceDays' | 'panelBlockedDays'>, now: number = Date.now()): LicenseState {
  return licensePhase({ paidThrough: sub.paidThrough ? sub.paidThrough.getTime() : null, graceDays: sub.graceDays, panelBlockedDays: sub.panelBlockedDays }, now);
}

/** Serializa los cambios de licencia de una suscripción: dos pagos o canjes simultáneos no pueden pisarse (lectura-modificación-escritura). */
async function lockSubscription(tx: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`license:${subscriptionId}`}))`;
}

function validateTerms(t: LicenseTermsInput, now: number): void {
  if (!Number.isInteger(t.graceDays) || t.graceDays < 0 || t.graceDays > 90) throw new ServiceError('invalid_license', 'Los días de gracia deben estar entre 0 y 90');
  if (!Number.isInteger(t.panelBlockedDays) || t.panelBlockedDays < 0 || t.panelBlockedDays > 180) {
    throw new ServiceError('invalid_license', 'Los días con el panel bloqueado deben estar entre 0 y 180');
  }
  if (t.paidThrough) {
    const ms = t.paidThrough.getTime();
    if (Number.isNaN(ms)) throw new ServiceError('invalid_license', 'Fecha de vigencia no válida');
    if (ms < Date.UTC(2020, 0, 1) || ms > now + 10 * 365 * DAY_MS) throw new ServiceError('invalid_license', 'La vigencia debe estar entre 2020 y dentro de 10 años');
  }
}

/** Fija los plazos de la licencia. `paidThrough: null` = sin caducidad. Hay que publicar (las acciones lo hacen solas). */
export async function setLicenseTerms(subscriptionId: string, terms: LicenseTermsInput, actor: ActingOperator, now: number = Date.now()) {
  assertCan(actor.role, 'billing:write');
  validateTerms(terms, now);
  return prisma.$transaction(async (tx) => {
    await lockSubscription(tx, subscriptionId);
    const sub = await tx.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
    const updated = await tx.subscription.update({
      where: { id: subscriptionId },
      data: { paidThrough: terms.paidThrough, graceDays: terms.graceDays, panelBlockedDays: terms.panelBlockedDays },
    });
    await appendAudit(tx, {
      actor,
      action: 'subscription.set_license',
      targetType: 'subscription',
      targetId: subscriptionId,
      tenantId: sub.tenantId,
      meta: {
        from: { paidThrough: sub.paidThrough?.toISOString() ?? null, graceDays: sub.graceDays, panelBlockedDays: sub.panelBlockedDays },
        to: { paidThrough: terms.paidThrough?.toISOString() ?? null, graceDays: terms.graceDays, panelBlockedDays: terms.panelBlockedDays },
      },
    });
    return updated;
  });
}

/** Registra un pago: la cobertura se alarga `days` días desde el fin de la actual (o desde hoy si ya había vencido). */
export async function registerPayment(subscriptionId: string, days: number, actor: ActingOperator, now: number = Date.now()) {
  assertCan(actor.role, 'billing:write');
  if (!Number.isInteger(days) || days < 1 || days > 1100) throw new ServiceError('invalid_license', 'Los días deben estar entre 1 y 1100');
  return prisma.$transaction(async (tx) => {
    await lockSubscription(tx, subscriptionId);
    const sub = await tx.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
    if (!sub.paidThrough) throw new ServiceError('license_not_expiring', 'Esta suscripción no caduca: fija primero una fecha de vigencia');
    const base = Math.max(now, sub.paidThrough.getTime());
    const next = new Date(base + days * DAY_MS);
    await tx.subscription.update({ where: { id: subscriptionId }, data: { paidThrough: next } });
    await appendAudit(tx, {
      actor,
      action: 'subscription.register_payment',
      targetType: 'subscription',
      targetId: subscriptionId,
      tenantId: sub.tenantId,
      meta: { days, from: sub.paidThrough.toISOString(), to: next.toISOString() },
    });
    return next;
  });
}

// ── Claves canjeables ─────────────────────────────────────────────────────────

// Sin 0/O/1/I/L para que se pueda dictar por teléfono. 20 caracteres de 32 símbolos = 100 bits.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const bytes = crypto.randomBytes(20);
  let raw = '';
  for (const b of bytes) raw += ALPHABET[b % ALPHABET.length];
  return `LGR-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code: string) => crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');

export type CreateKeyInput = { modules: string[]; extendDays: number; note?: string | null; expiresInDays?: number | null };

/** Crea una clave. El código en claro se devuelve UNA vez: en la BD solo queda su hash. */
export async function createLicenseKey(input: CreateKeyInput, actor: ActingOperator, now: number = Date.now()) {
  assertCan(actor.role, 'billing:write');
  const modules = [...new Set(input.modules)].sort();
  if (!Number.isInteger(input.extendDays) || input.extendDays < 0 || input.extendDays > 1100) throw new ServiceError('invalid_license', 'Los días de vigencia deben estar entre 0 y 1100');
  if (input.expiresInDays != null && (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 730)) {
    throw new ServiceError('invalid_license', 'La caducidad de la clave debe estar entre 1 y 730 días');
  }
  if (modules.length === 0 && input.extendDays === 0) throw new ServiceError('invalid_license', 'Una clave debe activar algún módulo o ampliar la vigencia');
  const known = await prisma.moduleDef.findMany({ where: { key: { in: modules } }, select: { key: true, isCore: true } });
  const unknown = modules.filter((m) => !known.some((k) => k.key === m));
  if (unknown.length) throw new ServiceError('unknown_module', `Módulo desconocido: ${unknown.join(', ')}`);
  const code = randomCode();
  const expiresAt = input.expiresInDays ? new Date(now + input.expiresInDays * DAY_MS) : null;
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.licenseKey.create({
      data: {
        codeHash: hashCode(code),
        codePrefix: normalizeCode(code).slice(0, 7), // «LGR» + 4 primeros caracteres
        modules,
        extendDays: input.extendDays,
        note: input.note?.slice(0, 200) || null,
        createdBy: actor.email,
        expiresAt,
      },
    });
    await appendAudit(tx, {
      actor,
      action: 'license_key.create',
      targetType: 'license_key',
      targetId: created.id,
      meta: { prefix: created.codePrefix, modules, extendDays: input.extendDays, expiresAt: expiresAt?.toISOString() ?? null },
    });
    return created;
  });
  return { id: row.id, code };
}

/** Canjea una clave sobre una suscripción: activa los módulos y/o alarga la vigencia. Un solo uso (reserva atómica). */
export async function redeemLicenseKey(subscriptionId: string, rawCode: string, actor: ActingOperator, now: number = Date.now()) {
  assertCan(actor.role, 'billing:write');
  const hash = hashCode(rawCode);
  return prisma.$transaction(async (tx) => {
    await lockSubscription(tx, subscriptionId);
    const sub = await tx.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
    const key = await tx.licenseKey.findUnique({ where: { codeHash: hash } });
    // Mismo mensaje para «no existe», «ya canjeada» y «caducada»: no se confirma qué códigos son reales.
    const invalid = new ServiceError('invalid_key', 'La clave no es válida o ya no se puede canjear');
    if (!key || key.redeemedAt || (key.expiresAt && key.expiresAt.getTime() < now)) throw invalid;
    if (key.extendDays > 0 && !sub.paidThrough) throw new ServiceError('license_not_expiring', 'Esta suscripción no caduca: la clave solo amplía vigencia, fija primero una fecha');

    const defs = await tx.moduleDef.findMany({ where: { productKey: sub.productKey } });
    const known = new Set(defs.map((d) => d.key));
    const wrongProduct = key.modules.filter((m) => !known.has(m));
    if (wrongProduct.length) throw new ServiceError('unknown_module', `La clave activa módulos que este producto no tiene: ${wrongProduct.join(', ')}`);

    // Reserva atómica: dos canjes simultáneos de la misma clave no pueden ganar los dos.
    const claimed = await tx.licenseKey.updateMany({
      where: { id: key.id, redeemedAt: null },
      data: { redeemedAt: new Date(now), redeemedBySubscriptionId: sub.id, redeemedBy: actor.email },
    });
    if (claimed.count !== 1) throw invalid;

    const current = new Set((await tx.subscriptionModule.findMany({ where: { subscriptionId: sub.id } })).map((m) => m.moduleKey));
    const added = key.modules.filter((m) => !current.has(m));
    if (added.length) {
      await tx.subscriptionModule.createMany({ data: added.map((moduleKey) => ({ subscriptionId: sub.id, moduleKey, source: 'KEY' as const, enabledBy: actor.id })) });
    }
    let paidThrough: Date | null = sub.paidThrough;
    if (key.extendDays > 0 && sub.paidThrough) {
      paidThrough = new Date(Math.max(now, sub.paidThrough.getTime()) + key.extendDays * DAY_MS);
      await tx.subscription.update({ where: { id: sub.id }, data: { paidThrough } });
    }
    await appendAudit(tx, {
      actor,
      action: 'license_key.redeem',
      targetType: 'subscription',
      targetId: sub.id,
      tenantId: sub.tenantId,
      meta: { prefix: key.codePrefix, added, extendDays: key.extendDays, paidThrough: paidThrough?.toISOString() ?? null },
    });
    return { added, paidThrough, tenantId: sub.tenantId };
  });
}

export async function listLicenseKeys(take = 100) {
  return prisma.licenseKey.findMany({ orderBy: { createdAt: 'desc' }, take });
}

// ── Revocación de emergencia ─────────────────────────────────────────────────

/**
 * Corta a un cliente en segundos escribiendo `revoked:{tenantId}` en el registro, sin republicar y sin depender de que el front
 * vea un snapshot nuevo. Primero el registro (el efecto), después la BD y la auditoría: si algo falla a medias, el cliente
 * queda cortado (el lado seguro).
 */
export async function emergencyRevoke(tenantId: string, actor: ActingOperator, store: RegistryStore = getRegistryStore(), now: number = Date.now()) {
  assertCan(actor.role, 'tenants:revoke');
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ServiceError('not_found', 'Cliente no encontrado');
  try {
    await store.put(registryKeyForRevocation(tenantId), String(now));
  } catch (err) {
    await prisma.$transaction((tx) =>
      appendAudit(tx, { actor, action: 'tenant.emergency_revoke_failed', targetType: 'tenant', targetId: tenantId, tenantId, meta: { error: String(err instanceof Error ? err.message : err).slice(0, 200) } })
    );
    throw new ServiceError('registry_unavailable', `No se pudo escribir en el registro: ${err instanceof Error ? err.message : err}`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { emergencyRevokedAt: new Date(now) } });
    await appendAudit(tx, { actor, action: 'tenant.emergency_revoke', targetType: 'tenant', targetId: tenantId, tenantId, meta: {} });
  });
}

export async function liftEmergencyRevocation(tenantId: string, actor: ActingOperator, store: RegistryStore = getRegistryStore()) {
  assertCan(actor.role, 'tenants:revoke');
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ServiceError('not_found', 'Cliente no encontrado');
  try {
    await store.del(registryKeyForRevocation(tenantId));
  } catch (err) {
    throw new ServiceError('registry_unavailable', `No se pudo escribir en el registro: ${err instanceof Error ? err.message : err}`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { emergencyRevokedAt: null } });
    await appendAudit(tx, { actor, action: 'tenant.emergency_revoke_lifted', targetType: 'tenant', targetId: tenantId, tenantId, meta: {} });
  });
}

// ── Refresco periódico ───────────────────────────────────────────────────────

/**
 * Vuelve a publicar todas las suscripciones que ya estaban publicadas. Es OBLIGATORIO que corra a diario: un snapshot pasa a
 * «obsoleto» a las 168 h y el front deja de avanzar la fase de licencia con uno obsoleto (no puede cobrar a quien no puede
 * registrar su pago). Sin este refresco, un cliente impagado se quedaría en la fase del último «Publicar».
 */
export async function refreshAllSnapshots(actor: ActingOperator, store: RegistryStore = getRegistryStore(), now: number = Date.now()) {
  assertCan(actor.role, 'publish');
  // Sin ningún dominio verificado no hay nada que publicar (se liberaron todos): se omite en lugar de fallar en cada ejecución.
  const subs = await prisma.subscription.findMany({
    where: { tenant: { status: { in: ['ACTIVE', 'SUSPENDED'] } }, lastPublishedAt: { not: null }, domains: { some: { status: 'VERIFIED' } } },
    select: { id: true, tenantId: true },
  });
  const failed: { subscriptionId: string; error: string }[] = [];
  let published = 0;
  for (const s of subs) {
    try {
      await publishSubscription(s.id, actor, store, now);
      published++;
    } catch (err) {
      failed.push({ subscriptionId: s.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { published, failed };
}
