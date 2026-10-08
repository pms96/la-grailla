import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import {
  KeyContext,
  SECRET_MASK,
  SecretDecryptionError,
  decryptSecret,
  encryptSecret,
  encryptSecretV2,
  isSensitiveConfigKey,
  isWriteOnlyConfigKey,
  registerKeyProvider,
  shouldDecryptOnRead,
} from '@/lib/secrets';

const GOLDEN_SECRET = 'golden-vector-secret-do-not-change';
const originalSecret = process.env.NEXTAUTH_SECRET;

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = GOLDEN_SECRET;
});
afterAll(() => {
  if (originalSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = originalSecret;
});

// VECTORES CONGELADOS. Se generaron con la implementación que hay en
// producción antes de introducir KeyProvider/enc:v2. Si alguno deja de
// descifrar, se ha cambiado la derivación de la clave legacy (HKDF de
// NEXTAUTH_SECRET con la etiqueta la-grailla-config-encryption-v1) y las
// credenciales de pago ya guardadas quedarían ilegibles. No "arreglar" el test.
describe('enc:v1 (vectores dorados)', () => {
  it('descifra valores escritos por la versión de producción', () => {
    expect(decryptSecret('enc:v1:hZDGzaOjqqvHbTtZ:QUcQvg83wpOVH7vEntKuqA==:ZBUf3qaqWD/w6IFf+6d/TlPVlWDONKgpIg==')).toBe(
      'sk_test_golden_vector_123'
    );
    expect(decryptSecret('enc:v1:hFSPT85KsCCNj6MD:5dAiMa8rmjm6GK4fS7WYLA==:AZN8Jdj6HyrE5+IHU5Tmx2E+dqispMs=')).toBe(
      'contraseña-ñ-€-🔥'
    );
  });

  it('cifra y descifra de ida y vuelta, con IV distinto cada vez', () => {
    const a = encryptSecret('valor');
    const b = encryptSecret('valor');
    expect(a.startsWith('enc:v1:')).toBe(true);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('valor');
  });

  it('deja pasar vacío y valores en texto plano antiguos', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
    expect(decryptSecret('sk_live_plano')).toBe('sk_live_plano');
  });

  it('lanza un error tipado (no devuelve vacío) si no puede descifrar', () => {
    const stored = encryptSecret('valor');
    process.env.NEXTAUTH_SECRET = 'otro-secreto-distinto';
    try {
      expect(() => decryptSecret(stored)).toThrow(SecretDecryptionError);
    } finally {
      process.env.NEXTAUTH_SECRET = GOLDEN_SECRET;
    }
  });

  it('detecta un valor manipulado', () => {
    const stored = encryptSecret('valor');
    const [iv, tag, ct] = stored.slice('enc:v1:'.length).split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() => decryptSecret(`enc:v1:${iv}:${tag}:${flipped.toString('base64')}`)).toThrow(SecretDecryptionError);
  });
});

describe('enc:v2', () => {
  beforeAll(() => {
    registerKeyProvider('test-kid', {
      getKey: ({ tenantId }: KeyContext) =>
        Buffer.from(crypto.hkdfSync('sha256', Buffer.from('master-de-prueba'), Buffer.alloc(0), Buffer.from(`t/${tenantId}`), 32)),
    });
  });

  const ctx = { kid: 'test-kid', tenantId: 'tenant-a', configKey: 'stripe_secret_key' };

  it('ida y vuelta con el mismo tenant y la misma clave de configuración', () => {
    const stored = encryptSecretV2('sk_live_x', ctx);
    expect(stored.startsWith('enc:v2:test-kid:')).toBe(true);
    expect(decryptSecret(stored, { tenantId: 'tenant-a', configKey: 'stripe_secret_key' })).toBe('sk_live_x');
  });

  it('un valor no se puede mover a otra fila (AAD con la clave de configuración)', () => {
    const stored = encryptSecretV2('sk_live_x', ctx);
    expect(() => decryptSecret(stored, { tenantId: 'tenant-a', configKey: 'sumup_api_key' })).toThrow(SecretDecryptionError);
  });

  it('un valor no se puede abrir desde otro tenant', () => {
    const stored = encryptSecretV2('sk_live_x', ctx);
    expect(() => decryptSecret(stored, { tenantId: 'tenant-b', configKey: 'stripe_secret_key' })).toThrow(SecretDecryptionError);
  });

  it('exige configKey y un kid conocido', () => {
    const stored = encryptSecretV2('sk_live_x', ctx);
    expect(() => decryptSecret(stored, { tenantId: 'tenant-a' })).toThrow(SecretDecryptionError);
    expect(() => decryptSecret('enc:v2:kid-desconocido:aaaa:bbbb:cccc', { configKey: 'x' })).toThrow(SecretDecryptionError);
  });
});

describe('clasificación de claves', () => {
  it('las credenciales se cifran y son de solo escritura', () => {
    expect(isSensitiveConfigKey('stripe_secret_key')).toBe(true);
    expect(isWriteOnlyConfigKey('stripe_secret_key')).toBe(true);
    expect(shouldDecryptOnRead('stripe_secret_key')).toBe(true);
  });

  it('smtp_password aún no se cifra al escribir, pero ya se lee y se enmascara', () => {
    expect(isSensitiveConfigKey('smtp_password')).toBe(false);
    expect(shouldDecryptOnRead('smtp_password')).toBe(true);
    expect(isWriteOnlyConfigKey('smtp_password')).toBe(true);
  });

  it('el resto de claves no se toca', () => {
    expect(isWriteOnlyConfigKey('admin_email')).toBe(false);
    expect(SECRET_MASK.length).toBeGreaterThan(0);
  });
});

// Revisión de seguridad de M4: GCM con tag de longitud fija. Sin `authTagLength`, Node acepta un tag truncado (p. ej. 4 bytes)
// y la autenticación queda reducida a 32 bits.
describe('tag GCM de longitud fija', () => {
  const v1 = 'enc:v1:hZDGzaOjqqvHbTtZ:QUcQvg83wpOVH7vEntKuqA==:ZBUf3qaqWD/w6IFf+6d/TlPVlWDONKgpIg==';

  it('rechaza un enc:v1 con el tag truncado', () => {
    const [prefix, iv, tag, ct] = [v1.slice(0, 7), ...v1.slice(7).split(':')];
    const short = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => decryptSecret(`${prefix}${iv}:${short}:${ct}`)).toThrow(SecretDecryptionError);
  });

  it('rechaza un enc:v2 con el tag truncado y acepta el entero', () => {
    // El proveedor `test-kid` lo registra el bloque de enc:v2 de arriba.
    const dctx = { tenantId: 'tenant-a', configKey: 'stripe_secret_key' };
    const sealed = encryptSecretV2('valor', { kid: 'test-kid', ...dctx });
    expect(decryptSecret(sealed, dctx)).toBe('valor');
    const parts = sealed.split(':'); // enc, v2, kid, iv, tag, ct
    parts[4] = Buffer.from(parts[4], 'base64').subarray(0, 4).toString('base64');
    expect(() => decryptSecret(parts.join(':'), dctx)).toThrow(SecretDecryptionError);
  });
});
