import { describe, it, expect } from 'vitest';
import { generateMasterKey, parseMasterKey, toBase64Url } from '@grailla/contracts';
import { signContext } from '@/lib/tenant/context-sign';
import { CONTEXT_MAX_AGE_MS, verifyContext } from '@/lib/tenant/context-verify';
import { testTenantContext } from '../helpers/tenant-dbs';

const key = parseMasterKey(generateMasterKey());
const NOW = 1_800_000_000_000;
const ctx = () => {
  const { testDbUrl: _t, ...rest } = testTenantContext('a');
  void _t;
  return rest;
};

describe('cabecera de contexto firmada (edge firma, Node verifica)', () => {
  it('ida y vuelta: lo que firma el middleware lo verifica el runtime Node', async () => {
    const header = await signContext(ctx(), key, NOW);
    expect(verifyContext(header, key, NOW + 1000)).toEqual(ctx());
  });

  it('rechaza una cabecera con otra clave, manipulada o mal formada', async () => {
    const header = await signContext(ctx(), key, NOW);
    expect(verifyContext(header, parseMasterKey(generateMasterKey()), NOW)).toBeNull();
    const [payload, mac] = header.split('.');
    const forgedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...ctx(), tenantId: 'OTRO', v: 1, iat: NOW })));
    expect(verifyContext(`${forgedPayload}.${mac}`, key, NOW)).toBeNull();
    expect(verifyContext(`${payload}.${mac.slice(0, -2)}AA`, key, NOW)).toBeNull();
    for (const bad of ['', 'sin-punto', 'a.b.c', '.', `${payload}.`, `.${mac}`, '%%%.%%%']) expect(verifyContext(bad, key, NOW)).toBeNull();
  });

  it('caduca: una cabecera vieja o del futuro no vale', async () => {
    const header = await signContext(ctx(), key, NOW);
    expect(verifyContext(header, key, NOW + CONTEXT_MAX_AGE_MS - 1)).not.toBeNull();
    expect(verifyContext(header, key, NOW + CONTEXT_MAX_AGE_MS + 1)).toBeNull();
    expect(verifyContext(header, key, NOW - 10_000)).toBeNull();
  });

  it('rechaza un contenido firmado pero que no cumple el esquema', async () => {
    const bad = { ...ctx(), status: 'HACKEADO' } as never;
    const header = await signContext(bad, key, NOW);
    expect(verifyContext(header, key, NOW)).toBeNull();
  });

  it('la cabecera no contiene la URL de BD en claro (solo valores sellados)', async () => {
    const header = await signContext(ctx(), key, NOW);
    const decoded = Buffer.from(header.split('.')[0], 'base64url').toString();
    expect(decoded).not.toMatch(/postgres(ql)?:\/\//);
    expect(decoded).not.toContain('testDbUrl');
  });
});
