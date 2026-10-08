// ULID: 48 bits de tiempo + 80 de azar en Crockford base32 → 26 caracteres,
// ordenable por creación. Es la identidad inmutable de un tenant: no se
// deriva del dominio ni del nombre, que sí cambian.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}

export function newUlid(now: number = Date.now(), random: (n: number) => Uint8Array = defaultRandom): string {
  if (!Number.isInteger(now) || now < 0 || now > 0xffffffffffff) throw new RangeError('timestamp fuera de rango para ULID');
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
  return time + rand;
}

function defaultRandom(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
