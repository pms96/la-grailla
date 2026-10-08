import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  assertSafeTestDatabase,
  disconnectTenantClients,
  ensureTenantDatabases,
  resetTenantDatabase,
  tenantClient,
  testDatabaseName,
  testDatabaseUrl,
} from '../helpers/tenant-dbs';

describe('salvaguardas del arnés de dos BDs', () => {
  it('acepta una BD local con prefijo de test', () => {
    expect(() => assertSafeTestDatabase('postgresql://u:p@localhost:5432/lagrailla_test_a')).not.toThrow();
    expect(() => assertSafeTestDatabase('postgresql://u:p@127.0.0.1:5432/lagrailla_test_b?connect_timeout=15')).not.toThrow();
  });

  it('rechaza la BD de desarrollo aunque sea local', () => {
    expect(() => assertSafeTestDatabase('postgresql://u:p@localhost:5432/lagrailla')).toThrow(/lagrailla_test_/);
    expect(() => assertSafeTestDatabase('postgresql://u:p@localhost:5432/postgres')).toThrow();
  });

  it('rechaza cualquier servidor remoto, aunque el nombre sea de test', () => {
    expect(() => assertSafeTestDatabase('postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/lagrailla_test_a')).toThrow(/no local/);
    expect(() => assertSafeTestDatabase('postgresql://u:p@localhost.evil.com/lagrailla_test_a')).toThrow();
  });

  it('se niega a operar si DATABASE_URL no es local', () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://u:p@ep-x.neon.tech/neondb';
    try {
      expect(() => testDatabaseUrl('a')).toThrow(/local/);
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });
});

describe('dos bases de datos independientes con el esquema real', () => {
  beforeAll(async () => {
    await ensureTenantDatabases();
    await resetTenantDatabase('a');
    await resetTenantDatabase('b');
  }, 180_000);

  afterAll(async () => {
    await disconnectTenantClients();
  });

  it('usa nombres distintos para A y B', () => {
    expect(testDatabaseName('a')).not.toBe(testDatabaseName('b'));
    expect(testDatabaseUrl('a')).not.toBe(testDatabaseUrl('b'));
  });

  it('un dato escrito en A no existe en B', async () => {
    const a = tenantClient('a');
    const b = tenantClient('b');
    await a.appConfig.create({ data: { key: 'site_name', value: 'Cliente A' } });
    await b.appConfig.create({ data: { key: 'site_name', value: 'Cliente B' } });

    expect((await a.appConfig.findUnique({ where: { key: 'site_name' } }))?.value).toBe('Cliente A');
    expect((await b.appConfig.findUnique({ where: { key: 'site_name' } }))?.value).toBe('Cliente B');

    await a.appConfig.create({ data: { key: 'solo_en_a', value: '1' } });
    expect(await b.appConfig.findUnique({ where: { key: 'solo_en_a' } })).toBeNull();
  });

  it('vaciar una BD no toca la otra', async () => {
    await resetTenantDatabase('a');
    expect(await tenantClient('a').appConfig.count()).toBe(0);
    expect(await tenantClient('b').appConfig.count()).toBeGreaterThan(0);
  });

  it('ambas tienen aplicado el mismo historial de migraciones', async () => {
    const counts = await Promise.all(
      (['a', 'b'] as const).map(async (slot) => {
        const rows = await tenantClient(slot).$queryRawUnsafe<{ n: bigint }[]>(
          'SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'
        );
        return Number(rows[0].n);
      })
    );
    expect(counts[0]).toBe(counts[1]);
    expect(counts[0]).toBeGreaterThan(0);
  });

  it('no deja rastro en la BD de desarrollo', async () => {
    const { prisma } = await import('@/lib/prisma');
    expect(await prisma.appConfig.findUnique({ where: { key: 'solo_en_a' } })).toBeNull();
  });
});
