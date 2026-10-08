import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import type { Domain, Prisma } from '@prisma/client';
import { normalizeHost } from '@grailla/contracts';
import type { ActingOperator } from '../actor';
import { appendAudit } from '../audit';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import { ServiceError } from './errors';

/** Días que un dominio liberado (que estuvo verificado) queda reservado antes de poder reclamarlo otro cliente. */
export const DOMAIN_COOLDOWN_DAYS = 30;
/** Un dominio reclamado y nunca verificado deja de bloquear a su legítimo dueño pasado este plazo. */
export const PENDING_CLAIM_DAYS = 7;
const DAY = 86_400_000;

export const verificationRecordName = (host: string) => `_grailla-verify.${host}`;
export const verificationRecordValue = (token: string) => `grailla-verify=${token}`;

export function newVerificationToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function parseHostOrThrow(raw: string): string {
  const host = normalizeHost(raw);
  if (!host) throw new ServiceError('invalid_host', 'El dominio no es válido (usa minúsculas, sin http:// ni rutas; los IDN en punycode)');
  return host;
}

/**
 * Reserva un host para una suscripción.
 * - Un dominio VERIFICADO de otro cliente no se puede reclamar.
 * - Uno solo PENDIENTE (nunca demostró control) bloquea como mucho PENDING_CLAIM_DAYS: así nadie puede
 *   okupar un dominio ajeno añadiéndolo sin verificar.
 * - Uno liberado que estuvo verificado queda como lápida: lo recupera el mismo cliente, u otro pasado
 *   DOMAIN_COOLDOWN_DAYS. Si nunca se verificó no hay lápida.
 * Se serializa por host: dos reclamaciones simultáneas no pueden ganar las dos.
 */
export async function claimDomain(
  tx: Prisma.TransactionClient,
  args: { host: string; subscriptionId: string; tenantId: string },
  now: number = Date.now()
): Promise<Domain> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.host}))`;
  const existing = await tx.domain.findUnique({ where: { host: args.host }, include: { subscription: { select: { tenantId: true } } } });
  if (!existing) {
    return tx.domain.create({
      data: { host: args.host, subscriptionId: args.subscriptionId, verificationToken: newVerificationToken() },
    });
  }
  const sameSubscription = existing.subscriptionId === args.subscriptionId;
  if (sameSubscription && existing.status !== 'RELEASED') throw new ServiceError('domain_exists', 'Este dominio ya está en la suscripción');
  if (existing.status === 'VERIFIED') throw new ServiceError('domain_taken', 'Este dominio ya pertenece a otro cliente');
  if (existing.status === 'PENDING') {
    const expired = now - existing.createdAt.getTime() > PENDING_CLAIM_DAYS * DAY;
    if (!expired) throw new ServiceError('domain_taken', 'Este dominio ya está reclamado por otro cliente (pendiente de verificar)');
  } else {
    // RELEASED: lápida solo si llegó a estar verificado.
    const sameTenant = existing.subscription.tenantId === args.tenantId;
    const freeAt = (existing.releasedAt?.getTime() ?? 0) + DOMAIN_COOLDOWN_DAYS * DAY;
    if (existing.verifiedAt && !sameTenant && now < freeAt) {
      throw new ServiceError('domain_reserved', `Este dominio se liberó hace poco y sigue reservado hasta el ${new Date(freeAt).toISOString().slice(0, 10)}`);
    }
  }
  return tx.domain.update({
    where: { id: existing.id },
    data: {
      subscriptionId: args.subscriptionId,
      status: 'PENDING',
      isPrimary: false,
      verifiedAt: null,
      releasedAt: null,
      createdAt: new Date(now),
      verificationToken: newVerificationToken(),
    },
  });
}

async function loadDomain(tx: Prisma.TransactionClient, id: string) {
  const d = await tx.domain.findUnique({ where: { id }, include: { subscription: true } });
  if (!d) throw new ServiceError('not_found', 'Dominio no encontrado');
  return d;
}

export async function addDomain(subscriptionId: string, rawHost: string, actor: ActingOperator, now: number = Date.now()): Promise<Domain> {
  assertCan(actor.role, 'tenants:write');
  const host = parseHostOrThrow(rawHost);
  return prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
    const domain = await claimDomain(tx, { host, subscriptionId, tenantId: sub.tenantId }, now);
    await appendAudit(tx, { actor, action: 'domain.add', targetType: 'domain', targetId: domain.id, tenantId: sub.tenantId, meta: { host } });
    return domain;
  });
}

async function markVerified(tx: Prisma.TransactionClient, domainId: string, actor: ActingOperator, how: 'dns' | 'manual', now: number) {
  const d = await loadDomain(tx, domainId);
  if (d.status === 'RELEASED') throw new ServiceError('domain_released', 'El dominio está liberado');
  if (d.status === 'VERIFIED') return d;
  const hasPrimary = (await tx.domain.count({ where: { subscriptionId: d.subscriptionId, status: 'VERIFIED', isPrimary: true } })) > 0;
  const updated = await tx.domain.update({
    where: { id: d.id },
    // El primer dominio verificado pasa a ser el principal.
    data: { status: 'VERIFIED', verifiedAt: new Date(now), isPrimary: !hasPrimary },
  });
  await appendAudit(tx, {
    actor,
    action: 'domain.verify',
    targetType: 'domain',
    targetId: d.id,
    tenantId: d.subscription.tenantId,
    meta: { host: d.host, how },
  });
  return updated;
}

type TxtResolver = (name: string) => Promise<string[][]>;

/** Comprueba el TXT `_grailla-verify.<host>` = `grailla-verify=<token>`. */
export async function verifyDomainDns(
  domainId: string,
  actor: ActingOperator,
  resolver: TxtResolver = dns.resolveTxt,
  now: number = Date.now()
): Promise<Domain> {
  assertCan(actor.role, 'tenants:write');
  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain) throw new ServiceError('not_found', 'Dominio no encontrado');
  let records: string[][] = [];
  try {
    records = await resolver(verificationRecordName(domain.host));
  } catch {
    records = [];
  }
  const expected = verificationRecordValue(domain.verificationToken);
  if (!records.some((chunks) => chunks.join('') === expected)) {
    throw new ServiceError('dns_not_found', `No se encontró el TXT ${verificationRecordName(domain.host)} con el valor esperado (puede tardar en propagarse)`);
  }
  return prisma.$transaction((tx) => markVerified(tx, domainId, actor, 'dns', now));
}

/** Verificación a mano (p. ej. dominio con DNS gestionado por el cliente): solo SUPERADMIN y queda auditada. */
export async function verifyDomainManually(domainId: string, actor: ActingOperator, now: number = Date.now()): Promise<Domain> {
  assertCan(actor.role, 'domains:verify-manual');
  return prisma.$transaction((tx) => markVerified(tx, domainId, actor, 'manual', now));
}

export async function setPrimaryDomain(domainId: string, actor: ActingOperator): Promise<void> {
  assertCan(actor.role, 'tenants:write');
  await prisma.$transaction(async (tx) => {
    const d = await loadDomain(tx, domainId);
    if (d.status !== 'VERIFIED') throw new ServiceError('domain_not_verified', 'Solo un dominio verificado puede ser el principal');
    await tx.domain.updateMany({ where: { subscriptionId: d.subscriptionId, isPrimary: true }, data: { isPrimary: false } });
    await tx.domain.update({ where: { id: d.id }, data: { isPrimary: true } });
    await appendAudit(tx, { actor, action: 'domain.set_primary', targetType: 'domain', targetId: d.id, tenantId: d.subscription.tenantId, meta: { host: d.host } });
  });
}

/** Libera un dominio: la fila queda como lápida y el siguiente publish retira su entrada del registro. */
export async function releaseDomain(domainId: string, actor: ActingOperator, now: number = Date.now()): Promise<void> {
  assertCan(actor.role, 'tenants:write');
  await prisma.$transaction(async (tx) => {
    const d = await loadDomain(tx, domainId);
    if (d.status === 'RELEASED') return;
    if (d.isPrimary) throw new ServiceError('domain_is_primary', 'No se puede liberar el dominio principal: elige otro como principal antes');
    await tx.domain.update({ where: { id: d.id }, data: { status: 'RELEASED', releasedAt: new Date(now) } });
    await appendAudit(tx, { actor, action: 'domain.release', targetType: 'domain', targetId: d.id, tenantId: d.subscription.tenantId, meta: { host: d.host } });
  });
}
