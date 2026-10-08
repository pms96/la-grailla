import crypto from 'crypto';

/* Cifrado en reposo para credenciales guardadas en AppConfig (pasarelas de
 * pago, certificados de Wallet, claves de IA) — un dump o acceso no autorizado
 * a la base de datos no debe exponer directamente las claves de cobro.
 *
 * FORMATOS
 *  - `enc:v1:{iv}:{tag}:{ct}` — el que se escribe hoy. La clave sale de
 *    NEXTAUTH_SECRET vía HKDF con la etiqueta `la-grailla-config-encryption-v1`.
 *    Esa etiqueta y la derivación NO se pueden tocar: invalidarían todo lo ya
 *    cifrado en producción (hay vectores de test congelados en
 *    tests/lib/secrets.test.ts).
 *  - `enc:v2:{kid}:{iv}:{tag}:{ct}` — preparado para varios clientes: `kid`
 *    elige el KeyProvider (rotación de claves) y el AAD de GCM es
 *    `tenantId|configKey`, así que un valor cifrado no se puede copiar a otra
 *    fila ni a otro cliente. Por ahora solo se LEE: no se escribe hasta que
 *    una versión anterior del código ya sepa leerlo (si no, un rollback dejaría
 *    ilegibles las credenciales). */

const V1_PREFIX = 'enc:v1:';
const V2_PREFIX = 'enc:v2:';
const HKDF_INFO_V1 = 'la-grailla-config-encryption-v1';

export const LEGACY_TENANT_ID = 'legacy';
export const LEGACY_KEY_ID = 'legacy';

// Se cifran al escribir (ver encryptSecret) y se enmascaran en la API de admin.
export const SENSITIVE_CONFIG_KEYS = [
  'stripe_secret_key',
  'stripe_webhook_secret',
  'sumup_api_key',
  'google_wallet_service_account',
  'apple_wallet_cert_p12_base64',
  'apple_wallet_cert_password',
  'abacus_ai_api_key',
];

// `smtp_password` se guardó siempre en claro. Se publica primero la LECTURA
// (descifra si el valor lleva prefijo, y si no lo devuelve tal cual) y solo en
// un release posterior se añade a SENSITIVE_CONFIG_KEYS para cifrarla al
// escribir — así un rollback entre ambos no deja a la app leyendo
// `enc:v1:...` como si fuese la contraseña SMTP.
const READ_DECRYPT_ONLY_KEYS = ['smtp_password'];

export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_CONFIG_KEYS.includes(key);
}

// Claves cuyo valor no debe salir hacia el navegador: la API de admin devuelve
// SECRET_MASK en su lugar (ver app/api/admin/config/route.ts).
export function isWriteOnlyConfigKey(key: string): boolean {
  return SENSITIVE_CONFIG_KEYS.includes(key) || READ_DECRYPT_ONLY_KEYS.includes(key);
}

export function shouldDecryptOnRead(key: string): boolean {
  return isWriteOnlyConfigKey(key);
}

export const SECRET_MASK = '••••••••';

export class SecretDecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SecretDecryptionError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

// Comparar secretos con !== filtra su valor byte a byte por temporización
// (cuanto más tarde en fallar la comparación, más caracteres iniciales
// acertó el atacante) — timingSafeEqual exige longitud igual, así que se
// compara primero para evitar que lanzar la excepción por longitud distinta
// sea en sí misma una fuga de longitud del secreto.
export function timingSafeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------- Proveedores de clave ---------- */

export type KeyContext = { tenantId: string; kid: string };

export interface KeyProvider {
  getKey(ctx: KeyContext): Buffer;
}

// Clave histórica de la instalación única: HKDF de NEXTAUTH_SECRET.
const legacyKeyProvider: KeyProvider = {
  getKey() {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
      throw new SecretDecryptionError(
        'NEXTAUTH_SECRET no está definido — es necesario para cifrar/descifrar credenciales'
      );
    }
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(HKDF_INFO_V1), 32));
  },
};

const keyProviders = new Map<string, KeyProvider>([[LEGACY_KEY_ID, legacyKeyProvider]]);

// Punto de extensión para claves por cliente (hkdf-master, KMS...). Los valores
// `enc:v2` llevan el `kid` que decide qué proveedor los abre.
export function registerKeyProvider(kid: string, provider: KeyProvider): void {
  if (!/^[A-Za-z0-9_-]+$/.test(kid)) throw new Error(`kid inválido: ${kid}`);
  keyProviders.set(kid, provider);
}

function providerFor(kid: string): KeyProvider {
  const provider = keyProviders.get(kid);
  if (!provider) throw new SecretDecryptionError(`No hay proveedor de clave para kid="${kid}"`);
  return provider;
}

/* ---------- Cifrado ---------- */

// Vacío se guarda tal cual: cifrar "" no aporta secreto ninguno y complica
// distinguir "sin configurar" de "valor cifrado" al leerlo.
export function encryptSecret(plainValue: string): string {
  if (!plainValue) return '';
  const key = legacyKeyProvider.getKey({ tenantId: LEGACY_TENANT_ID, kid: LEGACY_KEY_ID });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainValue, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${V1_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export type SecretV2Context = { kid: string; tenantId: string; configKey: string };

// NO se usa todavía para escribir (ver cabecera). Existe para fijar el
// formato con tests y para el momento en que haya clientes distintos.
export function encryptSecretV2(plainValue: string, ctx: SecretV2Context): string {
  if (!plainValue) return '';
  const key = providerFor(ctx.kid).getKey({ tenantId: ctx.tenantId, kid: ctx.kid });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${ctx.tenantId}|${ctx.configKey}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plainValue, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${V2_PREFIX}${ctx.kid}:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export type DecryptContext = { tenantId?: string; configKey?: string };

// Los valores guardados antes de introducir el cifrado siguen en texto plano —
// se devuelven tal cual (en vez de fallar) para no romper el pago en
// producción mientras el admin no vuelva a guardar esa credencial.
//
// Un valor CIFRADO que no se puede abrir (clave distinta, dato corrupto)
// lanza SecretDecryptionError. Antes devolvía '' y el siguiente guardado desde
// /admin/configuracion lo sobrescribía con vacío, perdiendo la credencial sin
// avisar.
export function decryptSecret(storedValue: string, ctx: DecryptContext = {}): string {
  if (!storedValue) return storedValue;
  if (storedValue.startsWith(V2_PREFIX)) return decryptV2(storedValue, ctx);
  if (storedValue.startsWith(V1_PREFIX)) return decryptV1(storedValue);
  return storedValue;
}

function decryptV1(storedValue: string): string {
  try {
    const [ivB64, authTagB64, ciphertextB64] = storedValue.slice(V1_PREFIX.length).split(':');
    const key = legacyKeyProvider.getKey({ tenantId: LEGACY_TENANT_ID, kid: LEGACY_KEY_ID });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof SecretDecryptionError) throw err;
    throw new SecretDecryptionError('No se pudo descifrar un valor de configuración (enc:v1)', { cause: err });
  }
}

function decryptV2(storedValue: string, ctx: DecryptContext): string {
  if (!ctx.configKey) {
    throw new SecretDecryptionError('Descifrar enc:v2 exige configKey (forma parte del AAD)');
  }
  const tenantId = ctx.tenantId ?? LEGACY_TENANT_ID;
  try {
    const [kid, ivB64, authTagB64, ciphertextB64] = storedValue.slice(V2_PREFIX.length).split(':');
    const key = providerFor(kid).getKey({ tenantId, kid });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(`${tenantId}|${ctx.configKey}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof SecretDecryptionError) throw err;
    throw new SecretDecryptionError(`No se pudo descifrar "${ctx.configKey}" (enc:v2)`, { cause: err });
  }
}
