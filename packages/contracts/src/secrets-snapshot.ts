import { z } from 'zod';
import { ULID_RE } from './ids';
import { CONTRACT_VERSION, KID_RE, SECRETS_TAG, fromBase64Url, message, toBase64Url } from './snapshot';

/* Segundo registro del plano de control: las URLs de BD de un cliente, SELLADAS (enc:v2).
 *
 * Va aparte del snapshot de enrutado a propósito: el enrutado lo lee el middleware en edge para
 * cada petición y no debe arrastrar material sensible; esto solo lo usa el runtime Node para abrir
 * la conexión del cliente. Aunque alguien leyese el almacén, los valores solo se abren con la clave
 * maestra del servidor, y el sobre va firmado (con otra etiqueta que el de enrutado) con `seq`
 * para que no se pueda reponer una URL antigua tras rotar la base de datos. */

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const sealed = z.string().startsWith('enc:v2:').max(2048);

export const SecretsSnapshotBodySchema = z.object({
  contractVersion: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  iat: z.number().int().nonnegative(),
  tenantId: z.string().regex(ULID_RE),
  product: slug,
  dbUrlPooledEnc: sealed,
  dbUrlDirectEnc: sealed,
});
export type SecretsSnapshotBody = z.infer<typeof SecretsSnapshotBodySchema>;

/** Campos (AAD) con los que el panel sella cada URL; el lector debe abrirlas con los mismos. */
export const DB_URL_POOLED_FIELD = 'db_url_pooled';
export const DB_URL_DIRECT_FIELD = 'db_url_direct';

export function registryKeyForSecrets(tenantId: string, product: string): string {
  if (!ULID_RE.test(tenantId) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(product)) throw new Error('tenant o producto no válidos para el registro');
  return `s:${tenantId}:${product}`;
}

const EnvelopeSchema = z.object({
  kid: z.string().regex(KID_RE),
  payload: z.string().min(2).max(16384),
  sig: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
});
export type SecretsSnapshotEnvelope = z.infer<typeof EnvelopeSchema>;

export async function signSecretsSnapshot(body: SecretsSnapshotBody, signer: { kid: string; privateKey: string }): Promise<SecretsSnapshotEnvelope> {
  if (!KID_RE.test(signer.kid)) throw new Error('kid inválido');
  const payload = JSON.stringify(SecretsSnapshotBodySchema.parse(body));
  const key = await crypto.subtle.importKey('pkcs8', fromBase64Url(signer.privateKey), 'Ed25519', false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, message(SECRETS_TAG, signer.kid, payload)));
  return { kid: signer.kid, payload, sig: toBase64Url(sig) };
}

export type SecretsVerifyFailure = 'malformed' | 'unknown_kid' | 'bad_signature' | 'unsupported_contract' | 'replay' | 'tenant_mismatch' | 'product_mismatch';
export type SecretsVerifyResult = { ok: true; body: SecretsSnapshotBody } | { ok: false; reason: SecretsVerifyFailure };

export async function verifySecretsSnapshot(
  input: unknown,
  opts: { keys: Record<string, string>; tenantId: string; product: string; lastSeq?: number | null; supportedContractVersion?: number }
): Promise<SecretsVerifyResult> {
  const env = EnvelopeSchema.safeParse(input);
  if (!env.success) return { ok: false, reason: 'malformed' };
  const { kid, payload, sig } = env.data;
  const publicKey = Object.prototype.hasOwnProperty.call(opts.keys, kid) ? opts.keys[kid] : undefined;
  if (!publicKey) return { ok: false, reason: 'unknown_kid' };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64Url(publicKey), 'Ed25519', false, ['verify']);
    valid = await crypto.subtle.verify('Ed25519', key, fromBase64Url(sig), message(SECRETS_TAG, kid, payload));
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
  const body = SecretsSnapshotBodySchema.safeParse(json);
  if (!body.success) return { ok: false, reason: 'malformed' };
  if (body.data.contractVersion > (opts.supportedContractVersion ?? CONTRACT_VERSION)) return { ok: false, reason: 'unsupported_contract' };
  if (body.data.tenantId !== opts.tenantId) return { ok: false, reason: 'tenant_mismatch' };
  if (body.data.product !== opts.product) return { ok: false, reason: 'product_mismatch' };
  if (opts.lastSeq != null && body.data.seq < opts.lastSeq) return { ok: false, reason: 'replay' };
  return { ok: true, body: body.data };
}
