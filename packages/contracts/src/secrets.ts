import { fromBase64Url, toBase64Url } from './snapshot';

/* Formato `enc:v2:{kid}:{iv}:{tag}:{ct}` (iv, tag y ct en base64 estándar), AES-256-GCM.
 *
 * - La clave de cada tenant sale de un maestro con HKDF-SHA256:
 *     salt = tenantId, info = `grailla-secrets-v2:{kid}`.
 *   Rotar = nuevo kid con otro maestro; los valores viejos siguen abriéndose
 *   con el suyo.
 * - El AAD de GCM es `{tenantId}|{field}`: un valor cifrado no se puede copiar a
 *   otra fila ni a otro cliente (falla la etiqueta).
 * - Es idéntico byte a byte al que lee `lib/secrets.ts` del front (hay un test
 *   de compatibilidad). WebCrypto devuelve ct||tag; aquí se separa la etiqueta. */

const PREFIX = 'enc:v2:';
const TAG_BYTES = 16;
const enc = new TextEncoder();
const dec = new TextDecoder();

export type SecretContext = { kid: string; tenantId: string; field: string };

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Maestro de 32 bytes en base64url (así viaja en variables de entorno). */
export function parseMasterKey(text: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text.trim());
  } catch {
    throw new SecretError('la clave maestra no es base64url válido');
  }
  if (bytes.length !== 32) throw new SecretError('la clave maestra debe tener 32 bytes');
  return bytes;
}

export function generateMasterKey(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export async function deriveTenantKey(master: Uint8Array, tenantId: string, kid: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(tenantId), info: enc.encode(`grailla-secrets-v2:${kid}`) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function isSealed(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** kid con el que se selló un valor (para elegir el maestro al abrirlo). */
export function sealedKid(value: string): string {
  if (!isSealed(value)) throw new SecretError('no es un valor enc:v2');
  const kid = value.slice(PREFIX.length).split(':')[0];
  if (!/^[A-Za-z0-9_-]+$/.test(kid)) throw new SecretError('kid inválido');
  return kid;
}

const aad = (ctx: SecretContext) => enc.encode(`${ctx.tenantId}|${ctx.field}`);

export async function sealSecret(plaintext: string, ctx: SecretContext, master: Uint8Array): Promise<string> {
  if (!plaintext) throw new SecretError('no se cifra un valor vacío');
  if (!/^[A-Za-z0-9_-]+$/.test(ctx.kid)) throw new SecretError('kid inválido');
  const key = await deriveTenantKey(master, ctx.tenantId, ctx.kid);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(ctx), tagLength: 128 }, key, enc.encode(plaintext))
  );
  const ct = out.slice(0, out.length - TAG_BYTES);
  const tag = out.slice(out.length - TAG_BYTES);
  return `${PREFIX}${ctx.kid}:${b64(iv)}:${b64(tag)}:${b64(ct)}`;
}

export async function openSecret(stored: string, ctx: Omit<SecretContext, 'kid'>, master: Uint8Array): Promise<string> {
  const kid = sealedKid(stored);
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 4) throw new SecretError('valor enc:v2 mal formado');
  try {
    const iv = unb64(parts[1]);
    const tag = unb64(parts[2]);
    const ct = unb64(parts[3]);
    const joined = new Uint8Array(ct.length + tag.length);
    joined.set(ct, 0);
    joined.set(tag, ct.length);
    const key = await deriveTenantKey(master, ctx.tenantId, kid);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad({ ...ctx, kid }), tagLength: 128 }, key, joined);
    return dec.decode(plain);
  } catch {
    throw new SecretError('no se pudo descifrar el valor (clave, tenant o campo no coinciden)');
  }
}
