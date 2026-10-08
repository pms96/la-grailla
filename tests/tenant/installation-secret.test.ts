import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { deriveInstallationSecret, parseMasterKey } from '@grailla/contracts';
import { runWithTenant } from '@/lib/tenant/context';
import { deriveInstallationSecretSync, getInstallationSecret, secretWriteTarget } from '@/lib/tenant/installation-secret';
import { TenantContextError } from '@/lib/tenant/context';
import { enablePlatformEnv } from '../helpers/platform';
import { testTenantContext } from '../helpers/tenant-dbs';

let env: ReturnType<typeof enablePlatformEnv>;
beforeEach(() => {
  env = enablePlatformEnv();
});
afterEach(() => env.restore());

const as = <T>(slot: 'a' | 'b', fn: () => T, over = {}) => runWithTenant(testTenantContext(slot, over), fn);

describe('secreto por cliente (modo plataforma)', () => {
  it('sin cliente asociado falla: nunca hay un secreto "por defecto"', () => {
    expect(() => getInstallationSecret('session')).toThrow(TenantContextError);
    expect(() => secretWriteTarget()).toThrow(TenantContextError);
  });

  it('cada cliente tiene el suyo, y cambia con la época y con el uso', () => {
    const a = as('a', () => getInstallationSecret('session'));
    const b = as('b', () => getInstallationSecret('session'));
    expect(a).not.toBe(b);
    expect(a).toBe(as('a', () => getInstallationSecret('session')));
    expect(as('a', () => getInstallationSecret('session'), { epoch: 1 })).not.toBe(a);
    expect(as('a', () => getInstallationSecret('access'))).not.toBe(a);
    expect(a).not.toContain('secreto-legacy');
  });

  it('el cálculo síncrono de Node coincide con el WebCrypto del edge (el middleware y los handlers deben dar lo mismo)', async () => {
    const master = parseMasterKey(env.PLATFORM_SESSION_MASTER);
    for (const [tenant, epoch, purpose] of [['01HF7YAT00AAAAAAAAAAAAAAAA', 0, 'session'], ['01HF7YAT00BBBBBBBBBBBBBBBB', 7, 'access']] as const) {
      expect(deriveInstallationSecretSync(master, tenant, epoch, purpose)).toBe(await deriveInstallationSecret(master, tenant, epoch, purpose));
    }
  });

  it('el cliente legacy conserva su secreto de siempre (sesiones y enlaces ya emitidos siguen valiendo)', () => {
    const legacy = { tenantId: env.LEGACY_TENANT_ID };
    expect(as('a', () => getInstallationSecret('session'), legacy)).toBe(env.LEGACY_NEXTAUTH_SECRET);
    expect(as('a', () => getInstallationSecret('access'), legacy)).toBe(env.LEGACY_NEXTAUTH_SECRET);
    expect(as('a', () => getInstallationSecret('config-v1'), legacy)).toBe(env.LEGACY_NEXTAUTH_SECRET);
  });

  it('enc:v1 solo se abre para el cliente legacy', () => {
    expect(() => as('a', () => getInstallationSecret('config-v1'))).toThrow(/legacy/);
  });

  it('formato de escritura: v2 para clientes nuevos, v1 para el legacy (compatibilidad con un rollback)', () => {
    expect(as('a', () => secretWriteTarget())).toEqual({ format: 'v2', tenantId: '01HF7YAT00AAAAAAAAAAAAAAAA', kid: 'tk' });
    expect(as('a', () => secretWriteTarget(), { tenantId: env.LEGACY_TENANT_ID })).toEqual({ format: 'v1' });
  });

  it('falla si falta el maestro de sesión (no cae a otro valor)', () => {
    delete process.env.PLATFORM_SESSION_MASTER;
    expect(() => as('a', () => getInstallationSecret('session'))).toThrow(TenantContextError);
  });

  it('modo normal: NEXTAUTH_SECRET, tal cual', () => {
    process.env.PLATFORM_MODE = 'off';
    process.env.NEXTAUTH_SECRET = 'el-de-siempre';
    expect(getInstallationSecret('session')).toBe('el-de-siempre');
    expect(secretWriteTarget()).toEqual({ format: 'v1' });
    expect(crypto.createHash('sha256').update(getInstallationSecret('access')).digest().length).toBe(32);
  });
});
