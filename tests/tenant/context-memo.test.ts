import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { signContext } from '@/lib/tenant/context-sign';
import { CONTEXT_MAX_AGE_MS } from '@/lib/tenant/context-verify';
import { testTenantContext } from '../helpers/tenant-dbs';

/* La cabecera de contexto vive 60 s entre el middleware y el handler, pero una petición larga (enviar entradas: hasta 120 s) sigue usando
 * `prisma` después. Se verifica una vez al leerla y no en cada acceso: pasados los 60 s la misma petición no puede quedarse sin cliente. */

const T0 = 1_800_000_000_000;
const masterRaw = generateMasterKey();
const key = parseMasterKey(masterRaw);
const ctx = () => {
  const { testDbUrl: _t, ...rest } = testTenantContext('a');
  void _t;
  return rest;
};

let header: string | null = null;
let currentTenant: typeof import('@/lib/tenant/context').currentTenant;
let reset: typeof import('@/lib/tenant/context').resetVerifiedContextForTests;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('next/headers', () => ({ headers: () => ({ get: (name: string) => (name === 'x-grailla-ctx' ? header : null) }) }));
  vi.stubEnv('PLATFORM_CONTEXT_KEY', masterRaw);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  ({ currentTenant, resetVerifiedContextForTests: reset } = await import('@/lib/tenant/context'));
  reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock('next/headers');
  header = null;
});

describe('verificar la cabecera una sola vez', () => {
  it('una petición que dura más de 60 s sigue teniendo cliente (antes fallaba a mitad)', async () => {
    header = await signContext(ctx(), key, T0);
    expect(currentTenant()?.tenantId).toBe(ctx().tenantId); // primera lectura, recién salida del middleware

    vi.setSystemTime(T0 + 120_000); // handler de 120 s
    expect(currentTenant()?.tenantId).toBe(ctx().tenantId);
  });

  it('una cabecera que llega ya caducada NO vale (la comprobación de edad sigue en la primera lectura)', async () => {
    header = await signContext(ctx(), key, T0);
    vi.setSystemTime(T0 + CONTEXT_MAX_AGE_MS + 1_000);
    expect(currentTenant()).toBeNull();
  });

  it('una cabecera falsificada no vale ni se recuerda', async () => {
    const other = parseMasterKey(generateMasterKey());
    header = await signContext(ctx(), other, T0);
    expect(currentTenant()).toBeNull();
    expect(currentTenant()).toBeNull();
  });

  it('la caducidad de la primera lectura es la de ESA cabecera: una nueva de otra petición se verifica por su cuenta', async () => {
    header = await signContext(ctx(), key, T0);
    expect(currentTenant()).not.toBeNull();
    vi.setSystemTime(T0 + 5 * 60_000);
    header = await signContext(ctx(), key, T0 + 1); // OTRA cabecera (distinta a la ya vista), ya vieja, que nunca se leyó a tiempo
    expect(currentTenant()).toBeNull();
  });

  it('lo recordado caduca (15 min) y se vuelve a comprobar', async () => {
    header = await signContext(ctx(), key, T0);
    expect(currentTenant()).not.toBeNull();
    vi.setSystemTime(T0 + 16 * 60_000);
    expect(currentTenant()).toBeNull();
  });

  it('cada lectura devuelve su propia copia: nadie puede alterar el contexto de otra lectura', async () => {
    header = await signContext(ctx(), key, T0);
    const a = currentTenant()!;
    a.status = 'SUSPENDED';
    expect(currentTenant()!.status).toBe('ACTIVE');
  });
});
