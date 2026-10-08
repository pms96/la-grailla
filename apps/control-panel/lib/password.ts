import bcrypt from 'bcryptjs';

export const MIN_PASSWORD_LENGTH = 12;
const COST = Number(process.env.BCRYPT_COST ?? 12);

const COMMON = ['contraseña1234', 'password1234', '123456789012', 'qwertyuiop12', 'administrador', 'lagrailla1234'];

/** Devuelve el motivo del rechazo, o null si la contraseña es aceptable. */
export function passwordPolicyError(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  // bcrypt ignora todo a partir del byte 72: se rechaza en vez de truncar en silencio.
  if (Buffer.byteLength(password, 'utf8') > 72) return 'La contraseña es demasiado larga (máximo 72 bytes)';
  if (/^(.)\1+$/.test(password)) return 'La contraseña no puede ser un solo carácter repetido';
  if (COMMON.includes(password.toLowerCase())) return 'Esa contraseña es demasiado común';
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return 'La contraseña no puede contener tu email';
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

let dummy: Promise<string> | null = null;
/** Compara contra un hash falso para que un email inexistente tarde lo mismo que uno real. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= bcrypt.hash('hash-señuelo-no-es-ninguna-contraseña', COST);
  await bcrypt.compare(password, await dummy);
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateTemporaryPassword(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
