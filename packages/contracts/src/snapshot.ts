import { z } from 'zod';
import { normalizeHost } from './hosts';
import { RoutingRecordSchema } from './routing-record';

/** Versión del contrato que entiende este código. Sube solo con cambios que rompen. */
export const CONTRACT_VERSION = 1;

export const ROUTING_TAG = 'grailla-snapshot-v1';
export const SECRETS_TAG = 'grailla-secrets-snapshot-v1';
export const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const SnapshotBodySchema = z.object({
  contractVersion: z.number().int().positive(),
  // Contador creciente por suscripción (tenant × producto): el lector rechaza snapshots más viejos que el
  // último visto para esa misma pareja (replay). Debe persistirlo fuera de la instancia (no vale la memoria de una lambda).
  seq: z.number().int().nonnegative(),
  iat: z.number().int().nonnegative(),
  // Pasado este instante el snapshot sigue siendo válido pero "obsoleto": nunca empeora por sí solo la licencia.
  staleUntil: z.number().int().nonnegative(),
  record: RoutingRecordSchema,
});
export type SnapshotBody = z.infer<typeof SnapshotBodySchema>;

export const SnapshotEnvelopeSchema = z.object({
  kid: z.string().regex(KID_RE),
  // Texto JSON exacto que se firmó (no se re-serializa).
  payload: z.string().min(2).max(65536),
  sig: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
});
export type SnapshotEnvelope = z.infer<typeof SnapshotEnvelopeSchema>;

/* ---- base64url sin dependencias (edge y Node) ---- */

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
// La etiqueta separa los "dominios" de firma: un snapshot de enrutado jamás verifica como snapshot de secretos.
export const message = (tag: string, kid: string, payload: string) => enc.encode(`${tag}\n${kid}\n${payload}`);

/* ---- claves ---- */

export async function generateSigningKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: toBase64Url(pkcs8), publicKey: toBase64Url(raw) };
}

/** Clave pública (raw, base64url) de una privada PKCS8: el JWK de una clave Ed25519 incluye `x`. */
export async function publicKeyOf(privateKeyPkcs8: string): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', fromBase64Url(privateKeyPkcs8), 'Ed25519', true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (!jwk.x) throw new Error('JWK sin clave pública');
  return jwk.x;
}

/* ---- firma y verificación ---- */

export async function signSnapshot(
  body: SnapshotBody,
  signer: { kid: string; privateKey: string }
): Promise<SnapshotEnvelope> {
  if (!KID_RE.test(signer.kid)) throw new Error('kid inválido');
  const valid = SnapshotBodySchema.parse(body); // nunca se firma un registro inválido
  const payload = JSON.stringify(valid);
  const key = await crypto.subtle.importKey('pkcs8', fromBase64Url(signer.privateKey), 'Ed25519', false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, message(ROUTING_TAG, signer.kid, payload)));
  return { kid: signer.kid, payload, sig: toBase64Url(sig) };
}

export type VerifyFailure = 'malformed' | 'unknown_kid' | 'bad_signature' | 'unsupported_contract' | 'replay' | 'host_mismatch' | 'product_mismatch';
export type VerifyResult =
  | { ok: true; body: SnapshotBody; stale: boolean }
  | { ok: false; reason: VerifyFailure };

export type VerifyOptions = {
  /** kid → clave pública raw en base64url. Varias a la vez permiten rotar. */
  keys: Record<string, string>;
  now: number;
  /**
   * Host con el que llegó la petición. OBLIGATORIO: una firma válida no basta, el snapshot tiene que
   * ser de ESTE dominio. Sin esto, quien pudiera escribir en el almacén copiaría el snapshot firmado
   * del cliente A bajo el dominio de otro y el front lo serviría.
   */
  host: string;
  /** Producto que sirve este despliegue (p. ej. "grailla"). Si se indica, el snapshot debe ser de ese producto. */
  product?: string;
  /** Último `seq` aceptado para este tenant y producto; uno menor se rechaza como repetición. */
  lastSeq?: number | null;
  supportedContractVersion?: number;
};

export async function verifySnapshot(input: unknown, opts: VerifyOptions): Promise<VerifyResult> {
  const env = SnapshotEnvelopeSchema.safeParse(input);
  if (!env.success) return { ok: false, reason: 'malformed' };
  const { kid, payload, sig } = env.data;

  const publicKey = Object.prototype.hasOwnProperty.call(opts.keys, kid) ? opts.keys[kid] : undefined;
  if (!publicKey) return { ok: false, reason: 'unknown_kid' };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64Url(publicKey), 'Ed25519', false, ['verify']);
    valid = await crypto.subtle.verify('Ed25519', key, fromBase64Url(sig), message(ROUTING_TAG, kid, payload));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const body = SnapshotBodySchema.safeParse(json);
  if (!body.success) return { ok: false, reason: 'malformed' };

  const supported = opts.supportedContractVersion ?? CONTRACT_VERSION;
  if (body.data.contractVersion > supported) return { ok: false, reason: 'unsupported_contract' };
  const host = normalizeHost(opts.host);
  if (!host || !body.data.record.domains.includes(host)) return { ok: false, reason: 'host_mismatch' };
  if (opts.product !== undefined && body.data.record.product !== opts.product) return { ok: false, reason: 'product_mismatch' };
  if (opts.lastSeq != null && body.data.seq < opts.lastSeq) return { ok: false, reason: 'replay' };

  return { ok: true, body: body.data, stale: opts.now > body.data.staleUntil };
}
