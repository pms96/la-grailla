import { describe, it, expect } from 'vitest';
import { SecretError, generateMasterKey, isSealed, openSecret, parseMasterKey, sealSecret, sealedKid } from '../src';

const master = parseMasterKey(generateMasterKey());
const ctx = { kid: 'm1', tenantId: '01HF7YAT00ABCDEFGHJKMNPQRS', field: 'database_url_pooled' };

describe('secretos enc:v2', () => {
  it('cifra y descifra de ida y vuelta', async () => {
    const sealed = await sealSecret('postgresql://u:p@host/db', ctx, master);
    expect(sealed.startsWith('enc:v2:m1:')).toBe(true);
    expect(isSealed(sealed)).toBe(true);
    expect(sealedKid(sealed)).toBe('m1');
    expect(sealed).not.toContain('postgresql');
    expect(await openSecret(sealed, ctx, master)).toBe('postgresql://u:p@host/db');
  });

  it('dos cifrados del mismo valor no coinciden (IV aleatorio)', async () => {
    expect(await sealSecret('x', ctx, master)).not.toBe(await sealSecret('x', ctx, master));
  });

  it('no abre el valor con otro tenant, otro campo u otro maestro', async () => {
    const sealed = await sealSecret('secreto', ctx, master);
    await expect(openSecret(sealed, { tenantId: '01HF7YAT00ABCDEFGHJKMNPQRT', field: ctx.field }, master)).rejects.toThrow(SecretError);
    await expect(openSecret(sealed, { tenantId: ctx.tenantId, field: 'database_url_direct' }, master)).rejects.toThrow(SecretError);
    await expect(openSecret(sealed, ctx, parseMasterKey(generateMasterKey()))).rejects.toThrow(SecretError);
  });

  it('detecta un valor manipulado', async () => {
    const sealed = await sealSecret('secreto', ctx, master);
    const parts = sealed.split(':');
    const ct = parts[5];
    parts[5] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await expect(openSecret(parts.join(':'), ctx, master)).rejects.toThrow(SecretError);
  });

  it('rechaza valores vacíos, kid inválido y entradas que no son enc:v2', async () => {
    await expect(sealSecret('', ctx, master)).rejects.toThrow(SecretError);
    await expect(sealSecret('x', { ...ctx, kid: 'a:b' }, master)).rejects.toThrow(SecretError);
    await expect(openSecret('texto-plano', ctx, master)).rejects.toThrow(SecretError);
    await expect(openSecret('enc:v2:m1:solo-uno', ctx, master)).rejects.toThrow(SecretError);
  });

  it('exige un maestro de 32 bytes', () => {
    expect(() => parseMasterKey('corto')).toThrow(SecretError);
  });
});
