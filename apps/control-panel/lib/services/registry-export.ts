import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { parseMasterKey } from '@grailla/contracts';
import { GENESIS_HASH, hashEntry } from '../audit';
import { prisma as defaultPrisma } from '../db';
import { ServiceError } from './errors';

/* Copia cifrada del REGISTRO (la BD de control): clientes, suscripciones, módulos, dominios, claves de licencia y auditoría. Es la
 * segunda red de seguridad tras el PITR de la BD: un fichero que se puede guardar FUERA de la plataforma.
 *
 *  - Cifrado AES-256-GCM con REGISTRY_EXPORT_KEY (32 bytes, distinta de las demás). Sin la clave el fichero no dice nada.
 *  - Las URLs de BD de los clientes van tal cual están en el registro (selladas enc:v2): para usarlas tras restaurar hace falta
 *    ADEMÁS SECRETS_KEYS. Guardar las dos claves aparte y no en el mismo sitio que el fichero.
 *  - NO incluye operadores, sesiones ni TOTP (se recrean con `operator:create`) ni datos operativos (ejecuciones de migración, estado
 *    de crons, salud: se regeneran solos).
 *  - Restaurar solo en una BD de control VACÍA (sin clientes ni auditoría): nunca mezcla ni pisa. Después, `snapshots:refresh`
 *    vuelve a publicar el almacén replicado, que se puede reconstruir entero desde aquí. */

export const EXPORT_FORMAT = 'grailla-registry-export';
export const EXPORT_VERSION = 1;
/** Al restaurar, el contador de snapshots salta este margen: los fronts rechazan un `seq` menor que el último visto (anti-replay) y la copia es anterior. */
export const RESTORE_SEQ_MARGIN = 100_000;

type Row = Record<string, unknown>;
export type RegistryDump = {
  products: Row[];
  moduleDefs: Row[];
  tenants: Row[];
  subscriptions: Row[];
  subscriptionModules: Row[];
  domains: Row[];
  licenseKeys: Row[];
  auditLog: Row[];
};

export type ExportEnvelope = {
  format: typeof EXPORT_FORMAT;
  v: typeof EXPORT_VERSION;
  createdAt: string;
  counts: Record<keyof RegistryDump, number>;
  iv: string;
  tag: string;
  ct: string;
};

const aad = (createdAt: string) => Buffer.from(`${EXPORT_FORMAT}|v${EXPORT_VERSION}|${createdAt}`, 'utf8');

export function exportKey(raw: string | undefined = process.env.REGISTRY_EXPORT_KEY): Buffer {
  if (!raw) throw new ServiceError('no_export_key', 'REGISTRY_EXPORT_KEY no está definido (32 bytes en base64url, distinta de las demás claves)');
  return Buffer.from(parseMasterKey(raw));
}

// Fechas y BigInt no son JSON: se marcan para recuperarlos exactos.
// (JSON.stringify llama a Date.toJSON ANTES del replacer: el valor original está en `this[key]`.)
function replacer(this: Record<string, unknown>, key: string, v: unknown): unknown {
  const raw = this[key];
  if (raw instanceof Date) return { $date: raw.toISOString() };
  return typeof v === 'bigint' ? { $bigint: v.toString() } : v;
}
const reviver = (_k: string, v: unknown) => {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$bigint === 'string' && Object.keys(o).length === 1) return BigInt(o.$bigint);
    if (typeof o.$date === 'string' && Object.keys(o).length === 1) return new Date(o.$date);
  }
  return v;
};

export async function readRegistry(db: PrismaClient = defaultPrisma): Promise<RegistryDump> {
  // Una sola transacción de lectura: las tablas son coherentes entre sí.
  return db.$transaction(
    async (tx) => ({
      products: await tx.product.findMany({ orderBy: { key: 'asc' } }),
      moduleDefs: await tx.moduleDef.findMany({ orderBy: [{ productKey: 'asc' }, { key: 'asc' }] }),
      tenants: await tx.tenant.findMany({ orderBy: { id: 'asc' } }),
      subscriptions: await tx.subscription.findMany({ orderBy: { id: 'asc' } }),
      subscriptionModules: await tx.subscriptionModule.findMany({ orderBy: [{ subscriptionId: 'asc' }, { moduleKey: 'asc' }] }),
      domains: await tx.domain.findMany({ orderBy: { id: 'asc' } }),
      licenseKeys: await tx.licenseKey.findMany({ orderBy: { id: 'asc' } }),
      auditLog: await tx.auditLog.findMany({ orderBy: { id: 'asc' } }),
    }),
    { timeout: 60_000 }
  ) as unknown as Promise<RegistryDump>;
}

export function sealDump(dump: RegistryDump, key: Buffer, now: Date = new Date()): ExportEnvelope {
  const createdAt = now.toISOString();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(createdAt));
  const ct = Buffer.concat([cipher.update(JSON.stringify(dump, replacer), 'utf8'), cipher.final()]);
  return {
    format: EXPORT_FORMAT,
    v: EXPORT_VERSION,
    createdAt,
    counts: Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v.length])) as ExportEnvelope['counts'],
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ct: ct.toString('base64url'),
  };
}

export function openDump(envelope: unknown, key: Buffer): { dump: RegistryDump; createdAt: string } {
  const e = envelope as Partial<ExportEnvelope>;
  if (!e || e.format !== EXPORT_FORMAT || e.v !== EXPORT_VERSION || !e.iv || !e.tag || !e.ct || !e.createdAt) {
    throw new ServiceError('invalid_export', 'No es un fichero de copia del registro (o es de una versión que no entiendo)');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64url'));
    decipher.setAAD(aad(e.createdAt));
    decipher.setAuthTag(Buffer.from(e.tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(e.ct, 'base64url')), decipher.final()]).toString('utf8');
    return { dump: JSON.parse(plain, reviver) as RegistryDump, createdAt: e.createdAt };
  } catch {
    // Clave equivocada o fichero alterado: GCM no distingue, y no hace falta.
    throw new ServiceError('export_decrypt_failed', 'No se pudo descifrar: la clave no es la correcta o el fichero está dañado');
  }
}

export async function exportRegistry(db: PrismaClient = defaultPrisma, key: Buffer = exportKey(), now: Date = new Date()): Promise<ExportEnvelope> {
  return sealDump(await readRegistry(db), key, now);
}

/** Comprueba la cadena de hashes de la auditoría de un volcado (sin BD). */
export function verifyDumpAuditChain(rows: Row[]): { ok: boolean; brokenAtId?: string } {
  let prev = GENESIS_HASH;
  for (const r of rows) {
    const expected = hashEntry(prev, {
      at: (r.at as Date).toISOString(),
      operatorId: r.operatorId as string | null,
      operatorEmail: r.operatorEmail as string,
      action: r.action as string,
      targetType: r.targetType as string,
      targetId: r.targetId as string,
      tenantId: r.tenantId as string | null,
      ip: r.ip as string | null,
      userAgent: r.userAgent as string | null,
      meta: r.meta,
    });
    if (r.prevHash !== prev || r.hash !== expected) return { ok: false, brokenAtId: String(r.id) };
    prev = r.hash as string;
  }
  return { ok: true };
}

/** Restaura en una BD de control VACÍA. Lanza si ya hay clientes o auditoría. */
export async function importRegistry(envelope: unknown, db: PrismaClient, key: Buffer = exportKey()): Promise<number> {
  const { dump } = openDump(envelope, key);
  const chain = verifyDumpAuditChain(dump.auditLog);
  if (!chain.ok) throw new ServiceError('audit_chain_broken', `La auditoría del fichero está alterada (entrada ${chain.brokenAtId}): no se restaura`);
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7001)`; // el mismo candado que serializa la auditoría
      const [tenants, audit] = await Promise.all([tx.tenant.count(), tx.auditLog.count()]);
      if (tenants > 0 || audit > 0) throw new ServiceError('registry_not_empty', 'La BD de control no está vacía: la restauración solo se hace sobre una vacía');
      // Orden por dependencias. El catálogo ya viene sembrado por las migraciones: se completa sin duplicar.
      await tx.product.createMany({ data: dump.products as never, skipDuplicates: true });
      await tx.moduleDef.createMany({ data: dump.moduleDefs as never, skipDuplicates: true });
      await tx.tenant.createMany({ data: dump.tenants as never });
      await tx.subscription.createMany({
        data: dump.subscriptions.map((sub) => ({ ...sub, snapshotSeq: (sub.snapshotSeq as number) + RESTORE_SEQ_MARGIN })) as never,
      });
      await tx.subscriptionModule.createMany({ data: dump.subscriptionModules as never });
      await tx.domain.createMany({ data: dump.domains as never });
      await tx.licenseKey.createMany({ data: dump.licenseKeys as never });
      await tx.auditLog.createMany({ data: dump.auditLog as never });
      // La secuencia debe seguir por detrás del último id restaurado.
      await tx.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"AuditLog"', 'id'), COALESCE((SELECT MAX(id) FROM "AuditLog"), 1), (SELECT COUNT(*) > 0 FROM "AuditLog"))`);
    },
    { timeout: 120_000 }
  );
  return dump.auditLog.length;
}
