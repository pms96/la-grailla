import { parseMasterKey } from '@grailla/contracts';

/* Comprobación de las variables de entorno del modo plataforma (edge-safe, sin secretos en los mensajes).
 *
 * Una variable mal puesta en el primer deploy no da un error: da un 503 mudo en TODOS los clientes. Esta comprobación corre una vez por
 * instancia, en la primera petición, y deja en el log QUÉ falta (nunca el valor). El preflight (`scripts/platform-preflight.ts`) hace
 * las mismas comprobaciones antes del corte; esto es la red de seguridad cuando algo cambia después. */

type Env = Record<string, string | undefined>;

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
  if (!env.UPSTASH_REDIS_REST_TOKEN) out.push('UPSTASH_REDIS_REST_TOKEN no está definida: el front no puede leer el registro de clientes');

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

  if (env.LEGACY_TENANT_ID && !env.LEGACY_NEXTAUTH_SECRET) out.push('LEGACY_TENANT_ID está definida pero falta LEGACY_NEXTAUTH_SECRET: las sesiones del cliente legacy no se podrán leer');
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
