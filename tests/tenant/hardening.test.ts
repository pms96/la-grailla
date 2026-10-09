import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { checkPlatformEnvOnce, platformEnvProblems, resetEnvCheckForTests } from '@/lib/tenant/env-check';
import { logRateLimited, resetLogRateLimitForTests } from '@/lib/tenant/log';
import { platformMiddleware } from '@/lib/tenant/middleware';
import { resetResolverStateForTests, setRegistryReaderForTests } from '@/lib/tenant/resolve';
import { enablePlatformEnv } from '../helpers/platform';
import { FakeRegistry, makeSigner, publishTenant } from '../helpers/registry';

const A = '01HF7YAT00AAAAAAAAAAAAAAAA';
let env: ReturnType<typeof enablePlatformEnv>;
let reg: FakeRegistry;
let errors: ReturnType<typeof vi.spyOn>;
const master = parseMasterKey(generateMasterKey());

beforeEach(async () => {
  const signer = await makeSigner();
  env = enablePlatformEnv({ SNAPSHOT_PUBKEYS: JSON.stringify({ [signer.kid]: signer.publicKey }) });
  reg = new FakeRegistry();
  resetResolverStateForTests();
  resetEnvCheckForTests();
  resetLogRateLimitForTests();
  setRegistryReaderForTests(reg);
  await publishTenant(reg, signer, { tenantId: A, hosts: ['a.cliente.test'], master, modules: ['tienda', 'entradas'] });
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
  env.restore();
  setRegistryReaderForTests(null);
  resetResolverStateForTests();
  resetEnvCheckForTests();
  resetLogRateLimitForTests();
});

const req = (host: string, path = '/', init: { method?: string } = {}) =>
  new NextRequest(`http://${host}${path}`, { method: init.method ?? 'GET', headers: { host } });
const logged = (needle: string) => errors.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes(needle));

describe('despliegues de vista previa de Vercel', () => {
  it('no sirven ningún cliente, aunque el dominio esté en el registro: 404 sin ni siquiera consultarlo', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const res = await platformMiddleware(req('a.cliente.test', '/eventos'));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-middleware-next')).toBeNull();
    expect(reg.calls).toEqual([]);
  });

  it('producción y desarrollo sí sirven', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await platformMiddleware(req('a.cliente.test', '/eventos'))).headers.get('x-middleware-next')).toBe('1');
    vi.stubEnv('VERCEL_ENV', 'development');
    expect((await platformMiddleware(req('a.cliente.test', '/eventos'))).headers.get('x-middleware-next')).toBe('1');
  });
});

describe('comprobación del entorno del modo plataforma', () => {
  const validEnv = () => ({
    UPSTASH_REDIS_REST_URL: 'https://eu.example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'token-de-prueba',
    SNAPSHOT_PUBKEYS: JSON.stringify({ k1: 'clave-publica' }),
    PLATFORM_CONTEXT_KEY: generateMasterKey(),
    PLATFORM_SESSION_MASTER: generateMasterKey(),
    PLATFORM_CRON_MASTER: generateMasterKey(),
    SECRETS_KEYS: JSON.stringify({ m1: generateMasterKey() }),
    SECRETS_ACTIVE_KID: 'm1',
  });

  it('un entorno completo no tiene problemas', () => {
    expect(platformEnvProblems(validEnv())).toEqual([]);
  });

  it.each([
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'SNAPSHOT_PUBKEYS',
    'PLATFORM_CONTEXT_KEY',
    'PLATFORM_SESSION_MASTER',
    'PLATFORM_CRON_MASTER',
    'SECRETS_KEYS',
  ])('si falta %s lo dice por su nombre', (name) => {
    const e: Record<string, string | undefined> = validEnv();
    delete e[name];
    const problems = platformEnvProblems(e);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(name);
  });

  it('un JSON roto en SNAPSHOT_PUBKEYS o un kid activo que no existe se detectan', () => {
    expect(platformEnvProblems({ ...validEnv(), SNAPSHOT_PUBKEYS: '{no es json' }).join('\n')).toContain('SNAPSHOT_PUBKEYS');
    expect(platformEnvProblems({ ...validEnv(), SNAPSHOT_PUBKEYS: '{}' }).join('\n')).toContain('SNAPSHOT_PUBKEYS');
    expect(platformEnvProblems({ ...validEnv(), SECRETS_ACTIVE_KID: 'otro' }).join('\n')).toContain('SECRETS_KEYS');
  });

  it('una clave con longitud o formato incorrectos se detecta', () => {
    expect(platformEnvProblems({ ...validEnv(), PLATFORM_CONTEXT_KEY: 'demasiado-corta' }).join('\n')).toContain('PLATFORM_CONTEXT_KEY');
  });

  it('el cliente legacy sin su secreto de sesión se detecta', () => {
    expect(platformEnvProblems({ ...validEnv(), LEGACY_TENANT_ID: A }).join('\n')).toContain('LEGACY_NEXTAUTH_SECRET');
  });

  it('los mensajes nunca contienen los valores', () => {
    const e = { ...validEnv(), PLATFORM_CONTEXT_KEY: 'valor-secreto-que-no-debe-salir', UPSTASH_REDIS_REST_TOKEN: '' };
    expect(platformEnvProblems(e).join('\n')).not.toContain('valor-secreto-que-no-debe-salir');
  });

  it('se registra una sola vez por instancia', () => {
    const lines: string[] = [];
    const first = checkPlatformEnvOnce({}, (m) => lines.push(m));
    const second = checkPlatformEnvOnce({}, (m) => lines.push(m));
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
    expect(lines).toHaveLength(first.length);
    expect(lines.every((l) => l.startsWith('[platform-env]'))).toBe(true);
  });

  it('el middleware lo comprueba en la primera petición y deja el motivo en el log', async () => {
    delete process.env.PLATFORM_CRON_MASTER;
    await platformMiddleware(req('a.cliente.test', '/eventos'));
    expect(logged('[platform-env]').join('\n')).toContain('PLATFORM_CRON_MASTER');
  });
});

describe('un 503 siempre deja su motivo en el log', () => {
  it('registro caído y sin caché', async () => {
    reg.failWith = new Error('el registro respondió 500');
    expect((await platformMiddleware(req('a.cliente.test'))).status).toBe(503);
    const lines = logged('[tenant-middleware] 503');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('a.cliente.test');
    expect(lines[0]).toContain('500');
  });

  it('sin repetirlo en cada petición (un mensaje por host y minuto)', async () => {
    reg.failWith = new Error('caído');
    for (let i = 0; i < 5; i++) await platformMiddleware(req('a.cliente.test'));
    expect(logged('[tenant-middleware] 503')).toHaveLength(1);
  });

  it('SNAPSHOT_PUBKEYS roto: todos los clientes darían 503 y ahora se sabe por qué', async () => {
    vi.stubEnv('SNAPSHOT_PUBKEYS', '{no es json');
    resetResolverStateForTests();
    expect((await platformMiddleware(req('a.cliente.test'))).status).toBe(503);
    expect(logged('SNAPSHOT_PUBKEYS no es un JSON válido').length).toBeGreaterThan(0);
  });

  it('sin PLATFORM_CONTEXT_KEY', async () => {
    delete process.env.PLATFORM_CONTEXT_KEY;
    expect((await platformMiddleware(req('a.cliente.test'))).status).toBe(503);
    expect(logged('PLATFORM_CONTEXT_KEY').length).toBeGreaterThan(0);
  });

  it('sin PLATFORM_SESSION_MASTER, en una ruta de staff', async () => {
    delete process.env.PLATFORM_SESSION_MASTER;
    expect((await platformMiddleware(req('a.cliente.test', '/admin'))).status).toBe(503);
    expect(logged('PLATFORM_SESSION_MASTER').length).toBeGreaterThan(0);
  });
});

describe('sin PLATFORM_SESSION_MASTER no caen los webhooks, los crons ni la salud', () => {
  it('solo se corta lo que necesita leer una sesión de staff', async () => {
    delete process.env.PLATFORM_SESSION_MASTER;
    for (const [path, method] of [
      ['/api/webhooks/stripe', 'POST'],
      ['/api/cron/reconcile-payments', 'GET'],
      ['/api/health', 'GET'],
      ['/eventos', 'GET'],
    ] as const) {
      const res = await platformMiddleware(req('a.cliente.test', path, { method }));
      expect(res.headers.get('x-middleware-next'), path).toBe('1');
    }
    expect((await platformMiddleware(req('a.cliente.test', '/api/admin/orders'))).status).toBe(503);
  });
});

describe('logRateLimited', () => {
  it('un mensaje por clave dentro de la ventana, y otra vez pasada la ventana', () => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    expect(logRateLimited('k', 'uno', { now: 1_000, log })).toBe(true);
    expect(logRateLimited('k', 'dos', { now: 30_000, log })).toBe(false);
    expect(logRateLimited('otra', 'tres', { now: 30_000, log })).toBe(true);
    expect(logRateLimited('k', 'cuatro', { now: 61_001, log })).toBe(true);
    expect(lines).toEqual(['uno', 'tres', 'cuatro']);
  });
});
