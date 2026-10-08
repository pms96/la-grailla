import crypto from 'node:crypto';
import { z } from 'zod';
import { LICENSE_PHASES, fromBase64Url, parseMasterKey } from '@grailla/contracts';
import type { TenantContext } from './context-types';

/* Verificación de la cabecera de contexto. SOLO Node (crypto síncrono: el cliente Prisma por tenant se tiene
 * que poder crear sin `await`, porque hay transacciones en forma de array y delegados que no admiten un envoltorio asíncrono). */

const ContextSchema = z.object({
  v: z.literal(1),
  iat: z.number().int(),
  tenantId: z.string().min(1).max(40),
  product: z.string().min(1).max(40),
  host: z.string().min(1).max(260),
  primaryDomain: z.string().min(1).max(260),
  epoch: z.number().int().nonnegative(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED']),
  modules: z.array(z.string().max(64)).max(64),
  license: z
    .object({
      phase: z.enum(LICENSE_PHASES),
      nextPhaseChangeAt: z.number().int().nonnegative().nullable(),
      schedule: z.array(z.object({ at: z.number().int().nonnegative(), phase: z.enum(LICENSE_PHASES) })).max(3).optional(),
    })
    .optional(),
  schemaVersion: z.string().max(128).nullable().optional(),
  db: z.object({ pooledEnc: z.string().max(2048), directEnc: z.string().max(2048) }),
});

/** Una cabecera solo debe vivir lo que dura la petición interna edge → Node. */
export const CONTEXT_MAX_AGE_MS = 60_000;

let cachedKey: { raw: string; value: Uint8Array } | null = null;
export function platformContextKey(): Uint8Array | null {
  const raw = process.env.PLATFORM_CONTEXT_KEY;
  if (!raw) return null;
  if (cachedKey?.raw === raw) return cachedKey.value;
  const value = parseMasterKey(raw);
  cachedKey = { raw, value };
  return value;
}

export function verifyContext(value: string, key: Uint8Array, now: number, maxAgeMs: number = CONTEXT_MAX_AGE_MS): TenantContext | null {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
  const payload = value.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(fromBase64Url(value.slice(dot + 1)));
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', key).update(payload).digest();
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  const parsed = ContextSchema.safeParse(json);
  if (!parsed.success) return null;
  const { iat, v: _v, ...ctx } = parsed.data;
  void _v;
  if (now - iat > maxAgeMs || iat - now > 5_000) return null;
  return ctx;
}
