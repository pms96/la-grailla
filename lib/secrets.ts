import crypto from 'crypto';

/* Cifrado en reposo para credenciales de pasarelas de pago guardadas en
 * AppConfig — hasta ahora `stripe_secret_key`, `stripe_webhook_secret` y
 * `sumup_api_key` se guardaban en texto plano; un dump o acceso no
 * autorizado a la base de datos exponía directamente las claves de cobro.
 *
 * La clave de cifrado se deriva de NEXTAUTH_SECRET (ya obligatorio y
 * secreto) vía HKDF con una etiqueta propia, en vez de exigir una variable
 * de entorno nueva — evita reutilizar el mismo secreto crudo para dos
 * propósitos distintos (firma de sesión vs. cifrado de config) sin añadir
 * un requisito de despliegue adicional. */

const ENCRYPTED_PREFIX = 'enc:v1:';
const HKDF_INFO = 'la-grailla-config-encryption-v1';

export const SENSITIVE_CONFIG_KEYS = ['stripe_secret_key', 'stripe_webhook_secret', 'sumup_api_key'];

export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_CONFIG_KEYS.includes(key);
}

function deriveKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET no está definido — es necesario para cifrar/descifrar credenciales de pago');
  }
  const derived = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(HKDF_INFO), 32);
  return Buffer.from(derived);
}

// Vacío se guarda tal cual: cifrar "" no aporta secreto ninguno y complica
// distinguir "sin configurar" de "valor cifrado" al leerlo.
export function encryptSecret(plainValue: string): string {
  if (!plainValue) return '';
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainValue, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

// Los valores guardados antes de introducir el cifrado siguen en texto
// plano — devolverlos tal cual (en vez de fallar) evita romper el pago en
// producción mientras el admin no vuelva a guardar esa credencial.
export function decryptSecret(storedValue: string): string {
  if (!storedValue || !storedValue.startsWith(ENCRYPTED_PREFIX)) return storedValue;
  try {
    const [ivB64, authTagB64, ciphertextB64] = storedValue.slice(ENCRYPTED_PREFIX.length).split(':');
    const key = deriveKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    console.error('[secrets] No se pudo descifrar un valor de configuración:', err instanceof Error ? err.message : err);
    return '';
  }
}
