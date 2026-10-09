import crypto from 'node:crypto';
import { generateMasterKey, generateSigningKeyPair, parseMasterKey, publicKeyOf } from '@grailla/contracts';

/* Claves de PRODUCCIÓN: se generan una vez, en local, y van a ficheros fuera del repositorio. Este módulo no imprime nunca un valor: solo
 * nombres y huellas (8 caracteres de un SHA-256, que de una clave aleatoria de 256 bits no revelan nada) para poder comprobar que el panel y
 * el front comparten la misma clave sin mostrarla.
 *
 * Perder `SECRETS_KEYS` es perder las URLs de BD de todos los clientes (y la copia del registro, que va cifrada con otra clave pero apunta a
 * ellas): guardar los tres ficheros en un gestor de contraseñas, no solo en Vercel. */

export const PLACEHOLDER = '__RELLENA__';

export type Vars = Record<string, string>;
export type ProdKeySet = {
  /** Variables del proyecto de Vercel del panel. */
  panel: Vars;
  /** Variables del proyecto de Vercel `platform` (el front en modo plataforma). */
  platform: Vars;
  /** NO van a Vercel: solo para las copias del registro que se hacen desde una máquina de operación. */
  ops: Vars;
};

const SECRETS_KID = 'm1';
const SNAPSHOT_KID = 's1';

/** Las variables que debe tener cada fichero: una que falte (o con otro nombre) no es un «__RELLENA__» y pasaría desapercibida. */
export const REQUIRED_KEYS = {
  panel: ['CONTROL_DATABASE_URL', 'CONTROL_DIRECT_URL', 'SECRETS_KEYS', 'SECRETS_ACTIVE_KID', 'SNAPSHOT_KID', 'SNAPSHOT_SIGNING_KEY', 'REGISTRY_STORE', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'PLATFORM_CRON_MASTER', 'CRON_SECRET'],
  platform: ['PLATFORM_MODE', 'AUTH_TRUST_HOST', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_READ_ONLY_TOKEN', 'SNAPSHOT_PUBKEYS', 'PLATFORM_CONTEXT_KEY', 'PLATFORM_SESSION_MASTER', 'PLATFORM_CRON_MASTER', 'SECRETS_KEYS', 'SECRETS_ACTIVE_KID'],
  ops: ['REGISTRY_EXPORT_KEY'],
} as const;

export async function generateProdKeys(): Promise<ProdKeySet> {
  const secretsKeys = JSON.stringify({ [SECRETS_KID]: generateMasterKey() });
  const signing = await generateSigningKeyPair();
  const cronMaster = generateMasterKey();
  return {
    panel: {
      CONTROL_DATABASE_URL: PLACEHOLDER,
      CONTROL_DIRECT_URL: PLACEHOLDER,
      SECRETS_KEYS: secretsKeys,
      SECRETS_ACTIVE_KID: SECRETS_KID,
      SNAPSHOT_KID,
      SNAPSHOT_SIGNING_KEY: signing.privateKey,
      REGISTRY_STORE: 'upstash',
      UPSTASH_REDIS_REST_URL: PLACEHOLDER,
      UPSTASH_REDIS_REST_TOKEN: PLACEHOLDER,
      PLATFORM_CRON_MASTER: cronMaster,
      CRON_SECRET: crypto.randomBytes(32).toString('base64url'),
    },
    platform: {
      PLATFORM_MODE: 'on',
      AUTH_TRUST_HOST: 'true',
      UPSTASH_REDIS_REST_URL: PLACEHOLDER,
      UPSTASH_REDIS_REST_READ_ONLY_TOKEN: PLACEHOLDER,
      SNAPSHOT_PUBKEYS: JSON.stringify({ [SNAPSHOT_KID]: signing.publicKey }),
      PLATFORM_CONTEXT_KEY: generateMasterKey(),
      PLATFORM_SESSION_MASTER: generateMasterKey(),
      PLATFORM_CRON_MASTER: cronMaster,
      SECRETS_KEYS: secretsKeys,
      SECRETS_ACTIVE_KID: SECRETS_KID,
    },
    ops: { REGISTRY_EXPORT_KEY: generateMasterKey() },
  };
}

/** `KEY=valor`; los JSON entre comillas simples (así los entienden tanto dotenv como «Import .env» de Vercel). */
export function renderEnv(vars: Vars, header: string): string {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v.startsWith('{') ? `'${v}'` : v}`);
  return `${header.trim().split('\n').map((l) => `# ${l}`).join('\n')}\n\n${lines.join('\n')}\n`;
}

export const HEADERS = {
  panel: 'Variables del proyecto de Vercel del PANEL (grailla-panel).\nSolo entorno Production, marcadas Sensitive. Rellena los __RELLENA__ con los datos de Neon y Upstash.\nNo subir a git ni pegar en ningún chat.',
  platform:
    'Variables del proyecto de Vercel PLATFORM (grailla-platform; el front en modo plataforma).\nSolo entorno Production, marcadas Sensitive. Aquí va el token de SOLO LECTURA de Upstash, nunca el de escritura.\nAl hacer el corte de La Grailla se añaden además LEGACY_TENANT_ID y LEGACY_NEXTAUTH_SECRET (el valor actual, idéntico) y BLOB_READ_WRITE_TOKEN.\nNo subir a git ni pegar en ningún chat.',
  ops: 'NO va a Vercel. Clave de las copias cifradas del registro (npm run registry:export / registry:import).\nGuárdala en un sitio distinto al de los ficheros de Vercel y al de las propias copias.',
};

export const fingerprint = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);

/* ───────────────────────────── Comprobación ───────────────────────────── */

export type KeyCheck = { status: 'pass' | 'fail' | 'warn'; title: string };
const pass = (title: string): KeyCheck => ({ status: 'pass', title });
const fail = (title: string): KeyCheck => ({ status: 'fail', title });
const warn = (title: string): KeyCheck => ({ status: 'warn', title });

function json(raw: string | undefined): Record<string, string> | null {
  try {
    const v = JSON.parse(raw ?? '');
    return v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string') ? (v as Record<string, string>) : null;
  } catch {
    return null;
  }
}
const filled = (v: string | undefined) => !!v && !v.includes(PLACEHOLDER);
function is32(v: string | undefined): boolean {
  try {
    return !!v && parseMasterKey(v).length === 32;
  } catch {
    return false;
  }
}

/** Valida los tres conjuntos ya rellenados. `dev` son las variables del `.env` local de desarrollo: ninguna clave de producción puede coincidir. */
export async function checkProdKeys(set: ProdKeySet, dev: Vars = {}): Promise<KeyCheck[]> {
  const out: KeyCheck[] = [];
  const { panel, platform, ops } = set;

  // 0 · Están todas las variables (con su nombre exacto).
  const missing = (['panel', 'platform', 'ops'] as const).flatMap((f) => REQUIRED_KEYS[f].filter((k) => !(k in set[f])).map((k) => `${k} (${f})`));
  out.push(missing.length ? fail(`Faltan variables o tienen otro nombre: ${missing.join(', ')}`) : pass('Todas las variables esperadas están en su fichero'));
  if ('UPSTASH_REDIS_REST_READ_ONLY_TOKEN' in panel) out.push(fail('panel.env lleva UPSTASH_REDIS_REST_READ_ONLY_TOKEN: el panel necesita el token de ESCRITURA con el nombre UPSTASH_REDIS_REST_TOKEN'));

  // 1 · Nada sin rellenar.
  const empty = [...Object.entries(panel).map(([k, v]) => ['panel', k, v] as const), ...Object.entries(platform).map(([k, v]) => ['platform', k, v] as const)].filter(([, , v]) => !filled(v));
  out.push(empty.length ? fail(`Sin rellenar: ${empty.map(([f, k]) => `${k} (${f})`).join(', ')}`) : pass('No queda ningún __RELLENA__'));

  // 2 · Lo que panel y front deben compartir, idéntico.
  for (const name of ['SECRETS_KEYS', 'SECRETS_ACTIVE_KID', 'PLATFORM_CRON_MASTER', 'UPSTASH_REDIS_REST_URL']) {
    const a = panel[name];
    const b = platform[name];
    if (!filled(a) || !filled(b)) continue;
    out.push(a === b ? pass(`${name} es el mismo en panel y front (huella ${fingerprint(a)})`) : fail(`${name} DIFIERE entre panel y front`));
  }

  // 3 · Formatos.
  const keys = json(panel.SECRETS_KEYS);
  out.push(keys && panel.SECRETS_ACTIVE_KID in keys && Object.values(keys).every(is32) ? pass('SECRETS_KEYS: JSON válido, la clave activa existe y mide 32 bytes') : fail('SECRETS_KEYS / SECRETS_ACTIVE_KID no son válidos'));
  for (const [file, vars, names] of [
    ['front', platform, ['PLATFORM_CONTEXT_KEY', 'PLATFORM_SESSION_MASTER', 'PLATFORM_CRON_MASTER']],
    ['panel', panel, ['PLATFORM_CRON_MASTER']],
    ['ops', ops, ['REGISTRY_EXPORT_KEY']],
  ] as const) {
    for (const n of names) out.push(is32(vars[n]) ? pass(`${n} (${file}): 32 bytes en base64url`) : fail(`${n} (${file}) no es una clave de 32 bytes en base64url`));
  }
  const cron = panel.CRON_SECRET ?? '';
  out.push(cron.length >= 24 && filled(cron) ? pass('CRON_SECRET: al menos 24 caracteres') : fail('CRON_SECRET debe tener al menos 24 caracteres'));

  // 4 · La clave pública del front corresponde a la privada del panel.
  try {
    const pubs = json(platform.SNAPSHOT_PUBKEYS);
    const pub = await publicKeyOf(panel.SNAPSHOT_SIGNING_KEY);
    out.push(pubs && pubs[panel.SNAPSHOT_KID] === pub ? pass(`SNAPSHOT_PUBKEYS[${panel.SNAPSHOT_KID}] corresponde a SNAPSHOT_SIGNING_KEY`) : fail('SNAPSHOT_PUBKEYS no contiene la clave pública de SNAPSHOT_SIGNING_KEY: el front rechazaría todos los registros'));
  } catch {
    out.push(fail('SNAPSHOT_SIGNING_KEY no es una clave Ed25519 PKCS8 válida'));
  }

  // 5 · Las claves de 32 bytes son todas distintas entre sí (una filtración de una no debe abrir otra).
  const distinct: [string, string | undefined][] = [
    ['SECRETS_KEYS', keys ? Object.values(keys)[0] : undefined],
    ['PLATFORM_CONTEXT_KEY', platform.PLATFORM_CONTEXT_KEY],
    ['PLATFORM_SESSION_MASTER', platform.PLATFORM_SESSION_MASTER],
    ['PLATFORM_CRON_MASTER', platform.PLATFORM_CRON_MASTER],
    ['REGISTRY_EXPORT_KEY', ops.REGISTRY_EXPORT_KEY],
  ];
  const seen = new Map<string, string>();
  const dup = distinct.filter(([n, v]) => {
    if (!v) return false;
    const other = seen.get(v);
    seen.set(v, n);
    return !!other;
  });
  out.push(dup.length ? fail(`Claves repetidas entre sí: ${dup.map(([n]) => n).join(', ')}`) : pass('Las claves maestras son todas distintas entre sí'));

  // 6 · Ninguna sale del entorno de desarrollo.
  const devValues = new Set(Object.values(dev).filter((v) => v.length >= 8));
  const reused = Object.entries({ ...panel, ...platform, ...ops }).filter(([k, v]) => filled(v) && v.length >= 8 && devValues.has(v) && !['REGISTRY_STORE', 'SECRETS_ACTIVE_KID', 'SNAPSHOT_KID'].includes(k));
  out.push(reused.length ? fail(`Valores iguales a los de desarrollo: ${[...new Set(reused.map(([k]) => k))].join(', ')}`) : pass('Ningún valor coincide con el .env de desarrollo'));

  // 7 · URLs: nada local, Neon con el endpoint correcto, Upstash por https y con tokens distintos.
  for (const name of ['CONTROL_DATABASE_URL', 'CONTROL_DIRECT_URL']) {
    const v = panel[name];
    if (!filled(v)) continue;
    try {
      const u = new URL(v);
      if (!/^postgres(ql)?:$/.test(u.protocol)) out.push(fail(`${name} no es una URL postgresql://`));
      else if (['localhost', '127.0.0.1', '::1'].includes(u.hostname)) out.push(fail(`${name} apunta a una BD local`));
      else if (name === 'CONTROL_DIRECT_URL' && u.hostname.includes('-pooler')) out.push(fail('CONTROL_DIRECT_URL es la URL pooled: las migraciones necesitan la directa (sin «-pooler»)'));
      else if (name === 'CONTROL_DATABASE_URL' && !u.hostname.includes('-pooler')) out.push(warn('CONTROL_DATABASE_URL no parece la URL pooled de Neon (sin «-pooler»)'));
      else if (name === 'CONTROL_DATABASE_URL' && u.searchParams.get('pgbouncer') !== 'true') out.push(warn('CONTROL_DATABASE_URL es pooled pero no lleva «pgbouncer=true» (añade &pgbouncer=true al final de la URL)'));
      else out.push(pass(`${name}: ${name === 'CONTROL_DIRECT_URL' ? 'directa' : 'pooled'}, host ${u.hostname.replace(/^[^.]*/, '…')}`));
    } catch {
      out.push(fail(`${name} no es una URL válida`));
    }
  }
  const up = panel.UPSTASH_REDIS_REST_URL;
  if (filled(up)) out.push(up.startsWith('https://') ? pass('UPSTASH_REDIS_REST_URL usa https') : fail('UPSTASH_REDIS_REST_URL debe empezar por https://'));
  const rw = panel.UPSTASH_REDIS_REST_TOKEN;
  const ro = platform.UPSTASH_REDIS_REST_READ_ONLY_TOKEN;
  if (filled(rw) && filled(ro)) out.push(rw !== ro ? pass('El token de escritura (panel) y el de solo lectura (front) son distintos') : fail('El front lleva el MISMO token que el panel: debe ser el «Read-Only Token» de Upstash'));
  if (filled(platform.UPSTASH_REDIS_REST_TOKEN)) out.push(fail('El front no debe llevar UPSTASH_REDIS_REST_TOKEN (el de escritura)'));
  return out;
}
