import { z } from 'zod';
import { parseMasterKey } from '@grailla/contracts';

// Se lee en el momento de uso (no al importar) para que los tests puedan fijarlo y
// para que un `next build` sin secretos no falle.

export type Keyring = { activeKid: string; masters: Record<string, Uint8Array> };

let cachedKeyring: { raw: string; value: Keyring } | null = null;

export function secretsKeyring(): Keyring {
  const rawKeys = process.env.SECRETS_KEYS ?? '';
  const activeKid = process.env.SECRETS_ACTIVE_KID ?? '';
  const cacheKey = `${activeKid}|${rawKeys}`;
  if (cachedKeyring?.raw === cacheKey) return cachedKeyring.value;
  let parsed: Record<string, string>;
  try {
    parsed = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), z.string()).parse(JSON.parse(rawKeys));
  } catch {
    throw new Error('SECRETS_KEYS no es un JSON {kid: clave base64url} válido');
  }
  const masters: Record<string, Uint8Array> = {};
  for (const [kid, text] of Object.entries(parsed)) masters[kid] = parseMasterKey(text);
  if (!masters[activeKid]) throw new Error('SECRETS_ACTIVE_KID no está en SECRETS_KEYS');
  const value = { activeKid, masters };
  cachedKeyring = { raw: cacheKey, value };
  return value;
}

export function snapshotSigner(): { kid: string; privateKey: string } {
  const kid = process.env.SNAPSHOT_KID;
  const privateKey = process.env.SNAPSHOT_SIGNING_KEY;
  if (!kid || !privateKey) throw new Error('SNAPSHOT_KID y SNAPSHOT_SIGNING_KEY son obligatorios para publicar');
  return { kid, privateKey };
}

export function snapshotStaleHours(): number {
  const n = Number(process.env.SNAPSHOT_STALE_HOURS ?? 168);
  return Number.isFinite(n) && n > 0 ? n : 168;
}
