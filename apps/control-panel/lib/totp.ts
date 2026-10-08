import crypto from 'node:crypto';

/* TOTP (RFC 6238): HMAC-SHA1, 6 dígitos, intervalos de 30 s. */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('base32 inválido');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', Buffer.from(base32Decode(secretBase32))).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Devuelve el intervalo que casó, o null. Acepta ±1 intervalo por desfase de reloj y
 * rechaza cualquier intervalo ya usado (`lastStep`), así un código no sirve dos veces.
 */
export function verifyTotp(secretBase32: string, input: string, nowMs: number, lastStep: number | null): number | null {
  const code = input.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Se recorren siempre los 3 intervalos (sin cortar al primero) para no filtrar cuál acertó por el tiempo.
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(totpCode(secretBase32, step));
    const given = Buffer.from(code);
    if (crypto.timingSafeEqual(expected, given) && matched === null && (lastStep === null || step > lastStep)) matched = step;
  }
  return matched;
}

export function otpauthUri(email: string, secretBase32: string, issuer = 'La Grailla Control'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/* ---- códigos de recuperación (de un solo uso) ---- */

const RC_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// 16 caracteres de un alfabeto de 31 símbolos ≈ 79 bits: con eso el hash SHA-256 sin sal no se puede
// atacar por fuerza bruta aunque alguien se lleve la BD.
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = crypto.randomBytes(16);
    const raw = Array.from(bytes, (b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
  });
}

export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export const looksLikeRecoveryCode = (input: string) => /^[2-9A-HJKMNP-Z]{16}$/.test(normalizeRecoveryCode(input));

export function hashRecoveryCode(input: string): string {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(input)).digest('hex');
}
