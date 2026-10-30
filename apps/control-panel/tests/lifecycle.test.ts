import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateMasterKey } from '@grailla/contracts';
import { engineEnv, pickSchemaEngine, versionPrinted } from '@/lib/migrations/executor';
import { describeMigration, runEngineCheck, runHealthCheck, runMigration } from '@/lib/services/lifecycle';
import type { MigrationRunResult } from '@/lib/services/migrations';
import { createTenant } from '@/lib/services/tenants';
import { verifyDomainManually } from '@/lib/services/domains';
import { ForbiddenError } from '@/lib/permissions';
import { ServiceError } from '@/lib/services/errors';
import { prisma } from '@/lib/db';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';
import { createScratchDb, dropScratchDb, makeFixturePrismaDir } from './scratch-db';

process.env.PLATFORM_CRON_MASTER = generateMasterKey();

const DB = 'lagrailla_scratch_lifecycle_a';
let url = '';
const M1 = '20270101000000_crea_tabla';
const GOOD = { [M1]: 'CREATE TABLE "demo" ("id" INTEGER PRIMARY KEY);' };

const run = (over: Partial<MigrationRunResult> = {}): MigrationRunResult => ({
  runId: 'r1',
  subscriptionId: 's1',
  tenantId: 't1',
  status: 'SUCCEEDED',
  dryRun: false,
  fromVersion: null,
  toVersion: M1,
  pending: [M1],
  attempts: 1,
  error: null,
  warnings: [],
  republishFailed: false,
  blockedBySales: false,
  ...over,
});

describe('describeMigration: el resultado del runner, en claro', () => {
  it('venta en marcha (P1-22): es un error con el motivo del runner, no un «BD al día»', () => {
    const o = describeMigration(run({ status: 'SKIPPED', blockedBySales: true, pending: [], toVersion: null, error: 'Venta en marcha (3 pedidos en los últimos 15 min, 40 en la sala de espera): no se migra ahora.' }));
    expect(o.ok).toBeUndefined();
    expect(o.error).toMatch(/Venta en marcha \(3 pedidos/);
  });

  it('aplicada: cuenta cuántas y de qué versión a cuál, y avisa de que la web sale del mantenimiento', () => {
    const o = describeMigration(run({ pending: ['a', 'b', 'c'], fromVersion: null, toVersion: M1 }));
    expect(o.ok).toMatch(/Aplicadas 3 migraciones: BD vacía → 20270101000000_crea_tabla/);
    expect(o.ok).toMatch(/mantenimiento/);
    expect(o.error).toBeUndefined();
  });

  it('BD ya al día: no dice que haya aplicado nada', () => {
    const o = describeMigration(run({ pending: [], fromVersion: M1, toVersion: M1 }));
    expect(o.ok).toMatch(/ya estaba al día/);
  });

  it('simulación: lista lo pendiente sin afirmar que cambió algo', () => {
    const o = describeMigration(run({ dryRun: true, pending: ['a', 'b'], toVersion: null }));
    expect(o.ok).toMatch(/Hay 2 migraciones por aplicar/);
    expect(o.ok).toMatch(/No se ha cambiado nada/);
    expect(o.details).toEqual(['a', 'b']);
    expect(describeMigration(run({ dryRun: true, pending: [] })).ok).toBe('No hay migraciones pendientes.');
  });

  it('una lista larga de pendientes se recorta', () => {
    const many = Array.from({ length: 55 }, (_, i) => `m${i}`);
    const o = describeMigration(run({ dryRun: true, pending: many }));
    expect(o.details).toHaveLength(41);
    expect(o.details!.at(-1)).toBe('… y 15 más');
  });

  it('fallo: error legible, sin ninguna URL de conexión aunque el driver la reproduzca', () => {
    const o = describeMigration(run({ status: 'FAILED', error: 'Error: P1001 no conecta con postgresql://usuario:secreto@ep-x.neon.tech/neondb?sslmode=require', pending: [M1] }));
    expect(o.error).toMatch(/^La migración falló/);
    expect(JSON.stringify(o)).not.toContain('secreto');
    expect(JSON.stringify(o)).not.toContain('ep-x.neon.tech');
    expect(o.ok).toBeUndefined();
  });

  it('migrada pero sin poder republicar: sigue contando lo hecho y pide publicar', () => {
    const o = describeMigration(run({ republishFailed: true, warnings: ['Upstash caído'] }));
    expect(o.ok).toMatch(/Aplicadas 1/);
    expect(o.error).toMatch(/Publicar/);
    expect(o.details).toEqual(['Upstash caído']);
  });
});

describe('motor de migraciones en el entorno', () => {
  it('elige el binario de esquema de la plataforma (en Vercel, Linux con OpenSSL 3)', () => {
    const names = ['schema-engine-darwin-arm64', 'schema-engine-debian-openssl-1.1.x', 'schema-engine-rhel-openssl-3.0.x', 'index.js', 'schema-engine-rhel-openssl-3.0.x.gz.sha256'];
    expect(pickSchemaEngine(names, 'linux')).toBe('schema-engine-rhel-openssl-3.0.x');
    expect(pickSchemaEngine(names, 'darwin')).toBe('schema-engine-darwin-arm64');
    expect(pickSchemaEngine(['index.js', 'README.md'], 'linux')).toBeNull();
  });

  it('prisma --version cuenta como correcto si imprime el motor, aunque salga con otro código (lo que pasa en Vercel)', () => {
    const printed = 'prisma : 6.7.0\nSchema Engine : schema-engine-cli abc\nSchema Wasm : x\nDefault Engines Hash : abc\nStudio : 0.511.0';
    expect(versionPrinted(printed)).toBe(true);
    expect(versionPrinted('Error: Cannot find module @prisma/debug')).toBe(false);
    expect(versionPrinted('')).toBe(false);
  });

  it('fuera de un entorno serverless no cambia el entorno del proceso hijo', () => {
    const saved = { v: process.env.VERCEL, l: process.env.AWS_LAMBDA_FUNCTION_NAME };
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    try {
      expect(engineEnv()).toEqual({});
    } finally {
      if (saved.v !== undefined) process.env.VERCEL = saved.v;
      if (saved.l !== undefined) process.env.AWS_LAMBDA_FUNCTION_NAME = saved.l;
    }
  });
});

describe('acciones de la puesta en marcha', () => {
  beforeAll(async () => {
    url = await createScratchDb(DB);
  });
  afterAll(async () => {
    await dropScratchDb(DB);
  });
  beforeEach(async () => {
    await resetControlDb();
    freshStore();
    url = await createScratchDb(DB);
  });

  async function tenant() {
    const { actor } = await makeOperator('SUPERADMIN');
    const created = await createTenant(tenantInput({ dbUrlPooled: url, dbUrlDirect: url }) as never, actor);
    return { actor, ...created };
  }

  it('el diagnóstico del motor funciona de verdad contra una BD: encuentra Prisma, el motor y llega a la BD, sin modificarla', async () => {
    const { actor, subscription } = await tenant();
    const dir = makeFixturePrismaDir(GOOD);
    const o = await runEngineCheck(subscription.id, actor, { prismaDir: dir });
    expect(o.error).toBeUndefined();
    expect(o.ok).toMatch(/funciona/);
    const text = o.details!.join('\n');
    expect(text).toMatch(/Carpeta prisma del front encontrada \(1 migraciones\)/);
    expect(text).toMatch(/Motor de esquema incluido: schema-engine-/);
    expect(text).toMatch(/llega a la BD del cliente: hay migraciones por aplicar/);
    expect(JSON.stringify(o)).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('el diagnóstico avisa si falta el esquema del front en el despliegue', async () => {
    const { actor, subscription } = await tenant();
    const o = await runEngineCheck(subscription.id, actor, { prismaDir: '/ruta/que/no/existe' });
    expect(o.ok).toBeUndefined();
    expect(o.error).toMatch(/NO está listo/);
    expect(o.details!.join('\n')).toMatch(/✗ No se encuentra el schema\.prisma/);
  });

  it('un VIEWER no puede migrar ni probar el motor', async () => {
    const { subscription } = await tenant();
    const { actor: viewer } = await makeOperator('VIEWER');
    await expect(runMigration(subscription.id, true, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runEngineCheck(subscription.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('comprobar salud exige un dominio verificado y guarda la respuesta del cliente', async () => {
    const { actor, subscription, domain, tenant: t } = await tenant();
    await expect(runHealthCheck(subscription.id, actor)).rejects.toBeInstanceOf(ServiceError);

    await verifyDomainManually(domain.id, actor);
    const detail = {
      status: 'ok',
      version: 'dev',
      platform: true,
      serving: true,
      tenantId: t.id,
      db: { ok: true, latencyMs: 4 },
      schema: { applied: M1, expected: M1, minRequired: M1, upToDate: true },
      onboarding: { complete: false, missing: ['legal_notice'] },
    };
    const o = await runHealthCheck(subscription.id, actor, { fetchImpl: async () => new Response(JSON.stringify(detail), { status: 200 }) });
    // Responde, pero le faltan datos mínimos: se cuenta como problema y se guarda lo que dijo.
    expect(o.error).toMatch(/Datos sin completar: legal_notice/);
    const saved = await prisma.tenantHealth.findUnique({ where: { subscriptionId: subscription.id } });
    expect(saved).toMatchObject({ onboardingComplete: false, onboardingMissing: ['legal_notice'], schemaApplied: M1 });
  });

  it('si la web no responde, lo dice y lo guarda como inalcanzable', async () => {
    const { actor, subscription, domain } = await tenant();
    await verifyDomainManually(domain.id, actor);
    const o = await runHealthCheck(subscription.id, actor, {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(o.error).toMatch(/La web no responde/);
    expect((await prisma.tenantHealth.findUnique({ where: { subscriptionId: subscription.id } }))!.status).toBe('unreachable');
  });
});
