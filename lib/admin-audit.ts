import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp } from '@/lib/rate-limit';

/* Registro de acciones del personal (P1-16 / OB-12): quién hizo qué, sobre qué y cuándo, en dinero, cuentas y accesos.
 *
 * Solo se añade: la aplicación no tiene ninguna ruta que edite o borre filas de AdminAuditLog. `meta` guarda lo mínimo para reconstruir el cambio
 * (importes, campos, claves de configuración tocadas) y NUNCA un secreto: `sanitizeAuditMeta` tapa cualquier clave con pinta de contraseña, token o
 * certificado y acota el tamaño. Para la configuración se registran los NOMBRES de las claves modificadas, jamás sus valores. */

export const AUDIT_ACTIONS = [
  'gasto.create', 'gasto.update', 'gasto.void',
  'ingreso.create', 'ingreso.update', 'ingreso.void',
  'temporada.close', 'temporada.reopen', 'temporada.update',
  'order.cancel', 'order.refund', 'order.complete', 'order.verify', 'order.update_email', 'order.shop_cancel', 'order.shop_refund',
  'event.cancel',
  'config.update',
  'user.create', 'user.update', 'user.delete',
  'role.create', 'role.update', 'role.delete',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditActor = { id?: string | null; email?: string | null };
export type AuditEntry = { action: AuditAction; targetType: string; targetId?: string | null; meta?: Record<string, unknown> };
/** El cliente normal o el de una transacción: así el rastro puede escribirse en la MISMA transacción que el cambio. */
export type AuditDb = { adminAuditLog: { create(args: { data: Prisma.AdminAuditLogUncheckedCreateInput }): PromiseLike<unknown> } };

const SECRET_KEY = /pass(word)?|secret|token|api_?key|authorization|cert|private|credential|hash|^enc$/i;
const MAX_STRING = 300;
const MAX_JSON = 4000;
const MAX_DEPTH = 4;
const REDACTED = '[redactado]';

function clean(value: unknown, depth: number, maxString: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'toFixed' in (value as object)) return String(value); // Decimal de Prisma
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1, maxString));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? REDACTED : clean(v, depth + 1, maxString);
    return out;
  }
  return String(value);
}

const size = (v: unknown) => JSON.stringify(v).length;

/**
 * Meta apta para guardar: sin secretos (por nombre de clave), con cadenas y tamaño acotados. Pura.
 * Si no cabe en MAX_JSON NO se descarta entera (H-017: se perdía hasta el importe anterior de una edición): primero se acortan las cadenas
 * y, solo si aun así no cabe, se conservan las claves de primer nivel que quepan, por orden, y se anotan las que se dejaron fuera.
 */
export function sanitizeAuditMeta(meta: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  for (const cap of [MAX_STRING, 120, 40]) {
    const cleaned = clean(meta, 0, cap) as Record<string, unknown>;
    if (size(cleaned) <= MAX_JSON) return cleaned as Prisma.InputJsonValue;
  }
  const cleaned = clean(meta, 0, 40) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  let used = 600; // reserva para `truncated` y la lista de claves omitidas
  for (const [k, v] of Object.entries(cleaned)) {
    const cost = size({ [k]: v }) + 1;
    if (used + cost <= MAX_JSON) {
      kept[k] = v;
      used += cost;
    } else dropped.push(k);
  }
  return { ...kept, truncated: true, keys: dropped.slice(0, 30) } as Prisma.InputJsonValue;
}

const comparable = (v: unknown): string => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v));

/** Campos que cambian entre dos versiones de una fila, como `{ campo: { from, to } }`. Compara por texto (Decimal y fechas incluidos). Pura. */
export function diffFields<T extends Record<string, unknown>>(before: T, after: T, keys: readonly (keyof T & string)[]): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) if (comparable(before[k]) !== comparable(after[k])) out[k] = { from: before[k], to: after[k] };
  return out;
}

export function actorFromSession(session: { user?: { id?: string | null; email?: string | null } } | null | undefined): AuditActor {
  return { id: session?.user?.id ?? null, email: session?.user?.email ?? null };
}

/** Escribe una fila de auditoría. Lanza si falla: úsala dentro de la transacción del cambio cuando éste no deba existir sin su rastro. */
export async function recordAdminAudit(db: AuditDb, actor: AuditActor, request: Request | undefined, entry: AuditEntry): Promise<void> {
  const ip = request ? getClientIp(request) : null;
  await db.adminAuditLog.create({
    data: {
      actorId: actor.id ?? null,
      actorEmail: actor.email ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      meta: sanitizeAuditMeta(entry.meta),
      ip: ip === 'unknown' ? null : ip,
    },
  });
}

/**
 * Igual, pero sin lanzar: para acciones que ya ocurrieron fuera de nuestra transacción (un reembolso en la pasarela, un cambio de claves) donde
 * fallar al anotar no debe deshacer ni ocultar lo hecho. El fallo se registra en el log del servidor (solo el mensaje, sin el objeto de error).
 */
export async function recordAdminAuditSafe(actor: AuditActor, request: Request | undefined, entry: AuditEntry): Promise<void> {
  try {
    await recordAdminAudit(prisma, actor, request, entry);
  } catch (error) {
    console.error(`[audit] no se pudo registrar ${entry.action}:`, error instanceof Error ? error.message : 'error desconocido');
  }
}
