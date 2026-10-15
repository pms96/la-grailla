import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { encode, decode } from 'next-auth/jwt';
import { GET as getEvents } from '@/app/api/events/route';
import { authOptions, getAuthOptions } from '@/lib/auth';
import { signOrderAccess, verifyOrderAccess } from '@/lib/access-token';
import { getConfig, getConfigOrThrow, setConfig } from '@/lib/config';
import { prisma } from '@/lib/prisma';
import { SecretDecryptionError } from '@/lib/secrets';
import { TenantContextError } from '@/lib/tenant/context';
import { tenantBlobPrefix } from '@/lib/tenant/blob';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { getBaseUrl, getFallbackBaseUrl } from '@/lib/url';
import { enablePlatformEnv } from '../helpers/platform';
import {
  TEST_TENANT_IDS,
  disconnectTenantClients,
  ensureTenantDatabases,
  resetTenantDatabase,
  tenantClient,
  testDatabaseUrl,
  withTenantForTest,
} from '../helpers/tenant-dbs';

/* Pruebas de aislamiento del modo plataforma: UN mismo código sirviendo a dos clientes con dos BDs reales distintas.
 * Si una sola de estas falla, un cliente podría ver o modificar datos de otro. */

let env: ReturnType<typeof enablePlatformEnv>;
const future = () => new Date(Date.now() + 30 * 86_400_000);

async function seed(slot: 'a' | 'b', name: string, price: number) {
  await tenantClient(slot).event.create({
    data: {
      name,
      slug: `evento-${slot}`,
      venue: `Sala ${slot.toUpperCase()}`,
      city: 'Test',
      date: future(),
      maxCapacity: 100,
      status: 'PUBLISHED',
      ticketTypes: { create: [{ name: `General ${slot}`, price, maxQuantity: 10 }] },
    },
  });
  await tenantClient(slot).appConfig.create({ data: { key: 'site_name', value: `Cliente ${slot.toUpperCase()}` } });
}

beforeAll(async () => {
  await ensureTenantDatabases();
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
  await seed('a', 'Evento de A', 12.5);
  await seed('b', 'Evento de B', 30);
  env = enablePlatformEnv();
}, 180_000);

afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('sin cliente asociado todo falla (fail-closed)', () => {
  it('prisma lanza en vez de caer a una BD por defecto', () => {
    expect(() => prisma.event).toThrow(TenantContextError);
    expect(() => prisma.$transaction).toThrow(TenantContextError);
  });

  it('un temporizador creado fuera de cualquier cliente tampoco puede tocar la BD', async () => {
    const outcome = await new Promise<string>((resolve) => {
      setTimeout(() => {
        try {
          void prisma.appConfig;
          resolve('LEAK');
        } catch (e) {
          resolve(e instanceof TenantContextError ? 'fail-closed' : 'otro error');
        }
      }, 5);
    });
    expect(outcome).toBe('fail-closed');
  });

  it('el secreto, la URL base y el prefijo de Blob también exigen cliente', () => {
    expect(() => getFallbackBaseUrl()).toThrow(TenantContextError);
    expect(() => tenantBlobPrefix()).toThrow(TenantContextError);
    expect(() => authOptions.secret).toThrow(TenantContextError);
    expect(() => signOrderAccess('o1')).toThrow(TenantContextError);
  });
});

describe('datos: cada cliente solo ve su BD', () => {
  it('el mismo código devuelve datos distintos según el cliente', async () => {
    const a = await withTenantForTest('a', () => prisma.appConfig.findUnique({ where: { key: 'site_name' } }));
    const b = await withTenantForTest('b', () => prisma.appConfig.findUnique({ where: { key: 'site_name' } }));
    expect(a?.value).toBe('Cliente A');
    expect(b?.value).toBe('Cliente B');
  });

  it('un handler REAL (GET /api/events) responde con los eventos de cada cliente y con la extensión Decimal→number', async () => {
    const asA = await withTenantForTest('a', async () => (await getEvents(new Request('http://x/api/events'))).json());
    const asB = await withTenantForTest('b', async () => (await getEvents(new Request('http://x/api/events'))).json());
    expect(asA.map((e: { name: string }) => e.name)).toEqual(['Evento de A']);
    expect(asB.map((e: { name: string }) => e.name)).toEqual(['Evento de B']);
    expect(asA[0].ticketTypes[0].price).toBe(12.5);
    expect(asB[0].ticketTypes[0].price).toBe(30);
  });

  it('300 peticiones intercaladas y concurrentes de los dos clientes no se mezclan', async () => {
    const jobs = Array.from({ length: 300 }, (_, i) => {
      const slot = i % 2 === 0 ? 'a' : 'b';
      return withTenantForTest(slot, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 15));
        const tx = await prisma.$transaction(async (t) => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return t.appConfig.findUnique({ where: { key: 'site_name' } });
        });
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        const direct = await prisma.appConfig.findUnique({ where: { key: 'site_name' } });
        return { slot, tx: tx?.value, direct: direct?.value };
      });
    });
    const results = await Promise.all(jobs);
    const wrong = results.filter((r) => r.tx !== `Cliente ${r.slot.toUpperCase()}` || r.direct !== `Cliente ${r.slot.toUpperCase()}`);
    expect(wrong).toEqual([]);
  });

  it('la transacción en forma de array también va a la BD del cliente', async () => {
    const [count, cfg] = await withTenantForTest('b', () => prisma.$transaction([prisma.event.count(), prisma.appConfig.findUnique({ where: { key: 'site_name' } })]));
    expect(count).toBe(1);
    expect(cfg?.value).toBe('Cliente B');
  });

  it('escribir como A no deja rastro en B', async () => {
    await withTenantForTest('a', () => prisma.appConfig.create({ data: { key: 'solo_a', value: '1' } }));
    expect(await withTenantForTest('b', () => prisma.appConfig.findUnique({ where: { key: 'solo_a' } }))).toBeNull();
    expect(await withTenantForTest('a', () => prisma.appConfig.findUnique({ where: { key: 'solo_a' } }))).not.toBeNull();
  });

  it('si el panel rota la BD de un cliente, el siguiente uso va a la nueva sin reiniciar', async () => {
    // Mismo tenantId, otra URL: debe abrir un cliente nuevo (la huella de la URL cambia).
    const rotated = await withTenantForTest('a', () => prisma.appConfig.findUnique({ where: { key: 'site_name' } }), { testDbUrl: testDatabaseUrl('b') });
    expect(rotated?.value).toBe('Cliente B');
    const back = await withTenantForTest('a', () => prisma.appConfig.findUnique({ where: { key: 'site_name' } }));
    expect(back?.value).toBe('Cliente A');
  });
});

describe('credenciales de pago: enc:v2 atado al cliente', () => {
  it('un cliente nuevo guarda enc:v2 y lo lee; el valor copiado a otro cliente no se abre', async () => {
    await withTenantForTest('a', () => setConfig('stripe_secret_key', 'sk_test_cliente_a'));
    const stored = await tenantClient('a').appConfig.findUniqueOrThrow({ where: { key: 'stripe_secret_key' } });
    expect(stored.value.startsWith('enc:v2:tk:')).toBe(true);
    expect(stored.value).not.toContain('sk_test');
    expect(await withTenantForTest('a', () => getConfigOrThrow('stripe_secret_key'))).toBe('sk_test_cliente_a');

    // Un administrador malicioso (o un error) copia el valor cifrado de A a la BD de B: no debe abrirse.
    await tenantClient('b').appConfig.create({ data: { key: 'stripe_secret_key', value: stored.value } });
    await expect(withTenantForTest('b', () => getConfigOrThrow('stripe_secret_key'))).rejects.toBeInstanceOf(SecretDecryptionError);
    expect(await withTenantForTest('b', () => getConfig('stripe_secret_key'))).toBe(''); // la lectura tolerante no la expone
    await tenantClient('b').appConfig.delete({ where: { key: 'stripe_secret_key' } });
  });

  it('el cliente legacy sigue escribiendo enc:v1 (un rollback del código seguiría leyéndolo)', async () => {
    await withTenantForTest('a', () => setConfig('stripe_secret_key', 'sk_test_legacy'), { tenantId: env.LEGACY_TENANT_ID });
    const stored = await tenantClient('a').appConfig.findUniqueOrThrow({ where: { key: 'stripe_secret_key' } });
    expect(stored.value.startsWith('enc:v1:')).toBe(true);
    await tenantClient('a').appConfig.delete({ where: { key: 'stripe_secret_key' } });
  });
});

describe('tokens de acceso (enlaces de pedidos, entradas y sponsors)', () => {
  it('un token de A no vale en B', () => {
    const token = withTenantForTest('a', () => signOrderAccess('pedido-1'));
    expect(withTenantForTest('a', () => verifyOrderAccess('pedido-1', token))).toBe(true);
    expect(withTenantForTest('b', () => verifyOrderAccess('pedido-1', token))).toBe(false);
  });

  it('subir la época de un cliente invalida SUS enlaces y no los de otros', () => {
    const tokenA = withTenantForTest('a', () => signOrderAccess('pedido-1'));
    const tokenB = withTenantForTest('b', () => signOrderAccess('pedido-1'));
    expect(withTenantForTest('a', () => verifyOrderAccess('pedido-1', tokenA), { epoch: 1 })).toBe(false);
    expect(withTenantForTest('b', () => verifyOrderAccess('pedido-1', tokenB), { epoch: 0 })).toBe(true);
  });

  it('el cliente legacy genera el MISMO token que el despliegue de siempre (los enlaces ya enviados siguen valiendo)', () => {
    const legacy = { tenantId: env.LEGACY_TENANT_ID };
    const viaPlatform = withTenantForTest('a', () => signOrderAccess('pedido-7'), legacy);
    // Cálculo independiente con el algoritmo original: HKDF(NEXTAUTH_SECRET, info) → HMAC('order:id') → 16 chars.
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(env.LEGACY_NEXTAUTH_SECRET), Buffer.alloc(0), Buffer.from('la-grailla-access-token-v1'), 32));
    const expected = crypto.createHmac('sha256', key).update('order:pedido-7').digest('base64url').slice(0, 16);
    expect(viaPlatform).toBe(expected);
  });
});

describe('sesión por cliente', () => {
  it('cada cliente firma con su secreto y `authOptions` (el Proxy) lo resuelve en cada lectura', () => {
    const a = withTenantForTest('a', () => authOptions.secret);
    const b = withTenantForTest('b', () => authOptions.secret);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    // getServerSession copia el objeto con Object.assign: tiene que llevarse el secreto del cliente y los callbacks.
    const copy = withTenantForTest('a', () => Object.assign({}, authOptions));
    expect(copy.secret).toBe(a);
    expect(typeof copy.callbacks?.session).toBe('function');
    expect(copy.session?.strategy).toBe('jwt');
  });

  it('la cookie de A no se descifra con el secreto de B', async () => {
    const secretA = withTenantForTest('a', () => getAuthOptions().secret!);
    const secretB = withTenantForTest('b', () => getAuthOptions().secret!);
    const jwt = await encode({ token: { id: 'u1', role: 'ADMIN' }, secret: secretA });
    expect((await decode({ token: jwt, secret: secretA }))?.role).toBe('ADMIN');
    // Con otro secreto la cookie ni siquiera se descifra (JWE): next-auth lanza y getServerSession lo trata como "sin sesión".
    await expect(decode({ token: jwt, secret: secretB })).rejects.toThrow();
  });

  it('cookies seguras (__Secure-) en dominios reales y sin ellas en *.localhost', () => {
    expect(withTenantForTest('a', () => getAuthOptions().useSecureCookies, { host: 'a.cliente.es' })).toBe(true);
    expect(withTenantForTest('a', () => getAuthOptions().useSecureCookies, { host: 'a.localhost:3000' })).toBe(false);
  });

  it('el callback de sesión rechaza un token de otro cliente y uno sin `tid` salvo en el legacy', async () => {
    // La sesión ahora se contrasta con la BD del cliente: el usuario del token tiene que existir en ella.
    await tenantClient('a').user.upsert({ where: { id: 'u' }, update: {}, create: { id: 'u', email: 'u-isolation@cliente.test', role: 'ADMIN' } });
    const session = { user: {}, expires: 'x' } as never;
    const run = (slot: 'a' | 'b', token: Record<string, unknown>, over = {}) =>
      withTenantForTest(slot, () => authOptions.callbacks!.session!({ session, token } as never), over) as unknown as Promise<{ user?: { role?: string } }>;
    expect((await run('a', { id: 'u', role: 'ADMIN', tid: TEST_TENANT_IDS.a })).user?.role).toBe('ADMIN');
    expect((await run('b', { id: 'u', role: 'ADMIN', tid: TEST_TENANT_IDS.a })).user).toBeUndefined();
    expect((await run('a', { id: 'u', role: 'ADMIN' })).user).toBeUndefined(); // cliente nuevo: el tid es obligatorio
    expect((await run('a', { id: 'u', role: 'ADMIN' }, { tenantId: env.LEGACY_TENANT_ID })).user?.role).toBe('ADMIN'); // legacy: sesiones anteriores
  });

  it('el callback jwt marca el token con el cliente al iniciar sesión', async () => {
    const token = await withTenantForTest('b', () => authOptions.callbacks!.jwt!({ token: {}, user: { id: 'u', role: 'ADMIN' } } as never));
    expect(token.tid).toBe(TEST_TENANT_IDS.b);
  });
});

describe('URLs absolutas', () => {
  it('salen del dominio principal verificado, nunca de las cabeceras (un Host manipulado no llega a un email)', () => {
    const evil = new Request('https://evil.example/x', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } });
    expect(withTenantForTest('a', () => getBaseUrl(evil), { host: 'a.cliente.es' })).toBe('https://a.cliente.es');
    expect(withTenantForTest('b', () => getFallbackBaseUrl(), { host: 'b.cliente.es' })).toBe('https://b.cliente.es');
  });

  it('en desarrollo (*.localhost) usa http y el puerto del host', () => {
    expect(withTenantForTest('a', () => getFallbackBaseUrl(), { host: 'a.localhost:57810' })).toBe('http://a.localhost:57810');
  });

  it('el prefijo de Blob es el del cliente', () => {
    expect(withTenantForTest('a', () => tenantBlobPrefix())).toBe(`${TEST_TENANT_IDS.a}/`);
    expect(withTenantForTest('b', () => tenantBlobPrefix())).toBe(`${TEST_TENANT_IDS.b}/`);
  });
});
