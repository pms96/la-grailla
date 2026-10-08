import { describe, it, expect } from 'vitest';
import { passwordPolicyError } from '@/lib/password';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from '@/lib/totp';

// Secreto de prueba del RFC 6238 ("12345678901234567890" en ASCII).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('coincide con los vectores del RFC (SHA-1, últimos 6 dígitos de los códigos de 8)', () => {
    // RFC 6238 apéndice B: T=59 → 94287082, T=1111111109 → 07081804, T=1234567890 → 89005924, T=2000000000 → 69279037
    expect(totpCode(RFC_SECRET, totpStep(59_000))).toBe('287082');
    expect(totpCode(RFC_SECRET, totpStep(1_111_111_109_000))).toBe('081804');
    expect(totpCode(RFC_SECRET, totpStep(1_234_567_890_000))).toBe('005924');
    expect(totpCode(RFC_SECRET, totpStep(2_000_000_000_000))).toBe('279037');
  });

  it('base32 es reversible', () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => i * 13);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });

  it('acepta el intervalo actual y ±1, y rechaza lo demás', () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now, null)).toBeNull();
  });

  it('no deja reutilizar un intervalo ya consumido', () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 34 5'])('rechaza entradas mal formadas (%j)', (input) => {
    expect(verifyTotp(RFC_SECRET, input, 1_800_000_000_000, null)).toBeNull();
  });

  it('acepta el código con espacios (así lo copian las apps)', () => {
    const now = 1_800_000_000_000;
    const code = totpCode(RFC_SECRET, totpStep(now));
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now, null)).not.toBeNull();
  });

  it('la URI otpauth lleva emisor, algoritmo y periodo', () => {
    const uri = otpauthUri('a@b.c', RFC_SECRET);
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('period=30');
  });
});

describe('códigos de recuperación', () => {
  it('genera 10 códigos distintos con formato xxxx-xxxx-xxxx-xxxx', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^([2-9A-HJKMNP-Z]{4}-){3}[2-9A-HJKMNP-Z]{4}$/);
      expect(looksLikeRecoveryCode(c)).toBe(true);
    }
  });

  it('se normaliza y se hashea igual con o sin guion y en minúsculas', () => {
    expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS');
    expect(hashRecoveryCode('abcd-efgh-jkmn-pqrs')).toBe(hashRecoveryCode('ABCDEFGHJKMNPQRS'));
  });

  it('un código TOTP de 6 dígitos no se confunde con uno de recuperación', () => {
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });
});

describe('política de contraseñas', () => {
  it.each([
    ['corta', 'abc123', /al menos 12/],
    ['de un solo carácter', 'aaaaaaaaaaaaaa', /repetido/],
    ['común', 'password1234', /común/],
    ['con el email', 'pablomunoz-2026-xx', /email/],
    ['más de 72 bytes', 'ñ'.repeat(40), /larga/],
  ])('rechaza una contraseña %s', (_n, pw, re) => {
    expect(passwordPolicyError(pw, 'pablomunoz@x.es')).toMatch(re);
  });

  it('acepta una contraseña razonable', () => {
    expect(passwordPolicyError('caballo-bateria-grapa-91', 'pablo@x.es')).toBeNull();
  });
});
