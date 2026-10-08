import { toBase64Url } from '@grailla/contracts';
import type { TenantContext } from './context-types';

/* Firma de la cabecera de contexto. Edge-safe (WebCrypto): la usa el middleware.
 * Formato: `{payload base64url}.{HMAC-SHA256 base64url}`, con `iat` dentro para limitar la vida de una cabecera. */

const enc = new TextEncoder();

export type SignedContextPayload = TenantContext & { v: 1; iat: number };

async function hmacKey(raw: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signContext(ctx: TenantContext, key: Uint8Array, now: number = Date.now()): Promise<string> {
  const payload = toBase64Url(enc.encode(JSON.stringify({ ...ctx, v: 1, iat: now } satisfies SignedContextPayload)));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), enc.encode(payload)));
  return `${payload}.${toBase64Url(mac)}`;
}
