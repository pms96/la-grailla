import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';

/* Registro de auditoría con cadena de hashes. La BD además impide UPDATE,
 * DELETE y TRUNCATE con un trigger (ver la migración init). */

export type Actor = { id: string | null; email: string; ip?: string | null; userAgent?: string | null };
export type AuditInput = {
  actor: Actor;
  action: string;
  targetType: string;
  targetId: string;
  tenantId?: string | null;
  meta?: Record<string, unknown>;
};

export const GENESIS_HASH = '0'.repeat(64);
const AUDIT_LOCK = 7001;

// Nada que parezca un secreto debe acabar en el registro de auditoría.
const FORBIDDEN_KEY = /(pass(word)?|secret|token|totp|recovery|sealed|database_?url|db_?url|private)/i;
const FORBIDDEN_VALUE = /^(enc:v\d|postgres(ql)?:\/\/)/i;

export function assertNoSecrets(value: unknown, path = 'meta'): void {
  if (typeof value === 'string' && FORBIDDEN_VALUE.test(value)) throw new Error(`${path} parece contener un secreto`);
  if (Array.isArray(value)) value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) throw new Error(`${path}.${k}: la auditoría no admite claves de aspecto secreto`);
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

type HashedFields = {
  at: string;
  operatorId: string | null;
  operatorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  tenantId: string | null;
  ip: string | null;
  userAgent: string | null;
  meta: unknown;
};

export function hashEntry(prevHash: string, f: HashedFields): string {
  return crypto.createHash('sha256').update(`${prevHash}\n${stableStringify(f)}`).digest('hex');
}

/** Añade una entrada dentro de una transacción ya abierta (serializa con un advisory lock). */
export async function appendAudit(tx: Prisma.TransactionClient, input: AuditInput): Promise<void> {
  const meta = JSON.parse(JSON.stringify(input.meta ?? {}));
  assertNoSecrets(meta);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK})`;
  const last = await tx.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } });
  const prevHash = last?.hash ?? GENESIS_HASH;
  const at = new Date();
  const userAgent = input.actor.userAgent?.slice(0, 300) ?? null;
  const fields: HashedFields = {
    at: at.toISOString(),
    operatorId: input.actor.id,
    operatorEmail: input.actor.email,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    tenantId: input.tenantId ?? null,
    ip: input.actor.ip ?? null,
    userAgent,
    meta,
  };
  await tx.auditLog.create({
    data: {
      at,
      operatorId: fields.operatorId,
      operatorEmail: fields.operatorEmail,
      action: fields.action,
      targetType: fields.targetType,
      targetId: fields.targetId,
      tenantId: fields.tenantId,
      ip: fields.ip,
      userAgent: fields.userAgent,
      meta,
      prevHash,
      hash: hashEntry(prevHash, fields),
    },
  });
}

export async function recordAudit(input: AuditInput): Promise<void> {
  await prisma.$transaction((tx) => appendAudit(tx, input));
}

export type ChainReport = { ok: boolean; checked: number; brokenAtId?: string; reason?: string };

export type AuditRow = {
  id: bigint;
  at: Date;
  operatorId: string | null;
  operatorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  tenantId: string | null;
  ip: string | null;
  userAgent: string | null;
  meta: unknown;
  prevHash: string;
  hash: string;
};

/** Comprueba un tramo consecutivo de filas a partir del hash anterior conocido. */
export function checkRows(prev: string, rows: AuditRow[]): { ok: true; prev: string } | { ok: false; brokenAtId: string; reason: string } {
  for (const r of rows) {
    if (r.prevHash !== prev) return { ok: false, brokenAtId: r.id.toString(), reason: 'prevHash no coincide' };
    const expected = hashEntry(prev, {
      at: r.at.toISOString(),
      operatorId: r.operatorId,
      operatorEmail: r.operatorEmail,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      tenantId: r.tenantId,
      ip: r.ip,
      userAgent: r.userAgent,
      meta: r.meta,
    });
    if (expected !== r.hash) return { ok: false, brokenAtId: r.id.toString(), reason: 'hash no coincide' };
    prev = r.hash;
  }
  return { ok: true, prev };
}

/** Recorre todo el registro recalculando la cadena. */
export async function verifyAuditChain(): Promise<ChainReport> {
  let prev = GENESIS_HASH;
  let checked = 0;
  let cursor: bigint | undefined;
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: cursor === undefined ? {} : { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: 500,
    });
    if (rows.length === 0) break;
    const res = checkRows(prev, rows);
    if (!res.ok) return { ok: false, checked, brokenAtId: res.brokenAtId, reason: res.reason };
    prev = res.prev;
    checked += rows.length;
    cursor = rows[rows.length - 1].id;
  }
  return { ok: true, checked };
}
