import { parseMasterKey } from '@grailla/contracts';

/* Comprobación de las variables de entorno del modo plataforma (edge-safe, sin secretos en los mensajes).
 *
 * Una variable mal puesta en el primer deploy no da un error: da un 503 mudo en TODOS los clientes. Esta comprobación corre una vez por
 * instancia, en la primera petición, y deja en el log QUÉ falta (nunca el valor). El preflight (`scripts/platform-preflight.ts`) hace
 * las mismas comprobaciones antes del corte; esto es la red de seguridad cuando algo cambia después. */

type Env = Record<string, string | undefined>;

/** Hostname exacto de un almacén público de Vercel Blob. Se repite en next.config.js y lib/images/blob-image.ts (CommonJS no puede importar este fichero). */
const BLOB_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.public\.blob\.vercel-storage\.com$/;

function jsonObject(raw: string | undefined): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw ?? '');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function keyProblem(env: Env, name: string): string | null {
  const raw = env[name];
  if (!raw) return `${name} no está definida`;
  try {
    parseMasterKey(raw);
    return null;
  } catch {
    return `${name} no es una clave válida (32 bytes en base64url)`;
  }
}

/** Qué falta o está mal en el entorno. Lista vacía = todo bien. */
export function platformEnvProblems(env: Env = process.env): string[] {
  const out: string[] = [];
  if (!env.UPSTASH_REDIS_REST_URL) out.push('UPSTASH_REDIS_REST_URL no está definida: el front no puede leer el registro de clientes');
  if (!env.UPSTASH_REDIS_REST_READ_ONLY_TOKEN && !env.UPSTASH_REDIS_REST_TOKEN) {
    out.push('UPSTASH_REDIS_REST_READ_ONLY_TOKEN no está definida: el front no puede leer el registro de clientes');
  } else if (!env.UPSTASH_REDIS_REST_READ_ONLY_TOKEN) {
    // El front no escribe nunca: con el token de escritura, quien lo comprometiera podría borrar la revocación de un cliente o reponer snapshots.
    out.push('El front lee el registro con el token de ESCRITURA (UPSTASH_REDIS_REST_TOKEN): usa el de solo lectura (UPSTASH_REDIS_REST_READ_ONLY_TOKEN)');
  }

  const pub = jsonObject(env.SNAPSHOT_PUBKEYS);
  if (!pub || Object.keys(pub).length === 0 || !Object.values(pub).every((v) => typeof v === 'string')) {
    out.push('SNAPSHOT_PUBKEYS no es un JSON {kid: clave pública} válido o está vacío: ningún snapshot se podrá verificar (todos los clientes darían 503)');
  }

  for (const name of ['PLATFORM_CONTEXT_KEY', 'PLATFORM_SESSION_MASTER', 'PLATFORM_CRON_MASTER']) {
    const p = keyProblem(env, name);
    if (p) out.push(p);
  }

  const keys = jsonObject(env.SECRETS_KEYS);
  const active = env.SECRETS_ACTIVE_KID ?? '';
  if (!keys || !(active in keys) || !Object.values(keys).every((v) => typeof v === 'string')) {
    out.push('SECRETS_KEYS / SECRETS_ACTIVE_KID no son válidos: no se podrán abrir las URLs de BD de los clientes');
  }

  // H-171: sin el host del almacén de Blob la CSP vuelve al comodín `*.public.blob.vercel-storage.com` y `isPlatformBlobHost` acepta cualquier almacén (logos, carteles y
  // borrados apuntando a uno ajeno; salida de datos por un XSS): el endurecimiento se apaga sin avisar. Misma forma que `next.config.js` y `lib/images/blob-image.ts`.
  if (!BLOB_HOST_RE.test((env.BLOB_PUBLIC_HOST ?? '').trim().toLowerCase())) {
    out.push('BLOB_PUBLIC_HOST no está definida o no tiene la forma <id>.public.blob.vercel-storage.com (solo el hostname): la CSP y las URLs de Blob quedarían abiertas a cualquier almacén');
  }

  if (env.LEGACY_TENANT_ID && !env.LEGACY_NEXTAUTH_SECRET) out.push('LEGACY_TENANT_ID está definida pero falta LEGACY_NEXTAUTH_SECRET: las sesiones del cliente legacy no se podrán leer');
  return out;
}

/**
 * Avisos que NO bloquean el servicio pero dejan mudo un canal de dinero (H-128): sin `PLATFORM_ALERT_URL` un reembolso fallido o un cobro sin pedido solo avisan por el correo del cliente (si tiene
 * `admin_email` y SMTP), y sin `SENTRY_DSN` los errores de los webhooks quedan solo en el log de Vercel. Lista vacía = los dos canales están.
 */
export function platformEnvWarnings(env: Env = process.env): string[] {
  const out: string[] = [];
  const alertUrl = env.PLATFORM_ALERT_URL?.trim();
  let alertOk = false;
  try {
    alertOk = !!alertUrl && new URL(alertUrl).protocol === 'https:';
  } catch {
    alertOk = false;
  }
  if (!alertOk) out.push('PLATFORM_ALERT_URL no está definida (o no es https): los avisos de dinero (reembolso fallido, cobro sin pedido) solo saldrían por el correo del cliente');
  if (!env.SENTRY_DSN?.trim()) out.push('SENTRY_DSN no está definida: los errores de cobros y webhooks quedan solo en el log de Vercel');
  return out;
}

const g = globalThis as unknown as { __grailla_env_checked?: boolean };

/** Registra los problemas una sola vez por instancia (la primera petición). Devuelve lo que encontró. */
export function checkPlatformEnvOnce(env: Env = process.env, log: (m: string) => void = (m) => console.error(m)): string[] {
  if (g.__grailla_env_checked) return [];
  g.__grailla_env_checked = true;
  const problems = platformEnvProblems(env);
  for (const p of problems) log(`[platform-env] ${p}`);
  return problems;
}

/** Solo tests. */
export function resetEnvCheckForTests(): void {
  g.__grailla_env_checked = undefined;
}
