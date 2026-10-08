import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { verifyAuditChain } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { verifyDomainManually } from '@/lib/services/domains';
import { RESTORE_SEQ_MARGIN, exportRegistry, importRegistry, openDump, verifyDumpAuditChain, readRegistry } from '@/lib/services/registry-export';
import { publishSubscription } from '@/lib/services/snapshot';
import { createLicenseKey } from '@/lib/services/license';
import { freshStore, makeOperator, resetControlDb, rootCreateTenant } from './helpers';
import { createScratchDb, dropScratchDb } from './scratch-db';

const KEY = Buffer.from(parseMasterKey(generateMasterKey()));
const TARGET = 'lagrailla_scratch_registry_restore';
let target: PrismaClient;

/** BD de control vacía con el esquema del panel (las migraciones reales). */
async function freshControlDb(): Promise<PrismaClient> {
  const url = await createScratchDb(TARGET);
  const r = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    env: { ...process.env, CONTROL_DATABASE_URL: url, CONTROL_DIRECT_URL: url },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`migrate deploy del panel falló: ${r.stdout}${r.stderr}`);
  return new PrismaClient({ datasourceUrl: url, log: [] });
}

beforeAll(async () => {
  target = await freshControlDb();
}, 120_000);
afterAll(async () => {
  await target?.$disconnect();
  await dropScratchDb(TARGET);
}, 60_000);
beforeEach(async () => {
  await resetControlDb();
});

async function populate() {
  const { actor } = await makeOperator('SUPERADMIN');
  const { subscription, domain } = await rootCreateTenant();
  await verifyDomainManually(domain.id, actor);
  await publishSubscription(subscription.id, actor, freshStore());
  await createLicenseKey({ modules: ['tienda'], extendDays: 30, note: 'prueba' }, actor);
  return { subscription, domain };
}

describe('copia cifrada del registro', () => {
  it('ida y vuelta: lo exportado se restaura idéntico en una BD vacía y la auditoría sigue verificando', async () => {
    const { subscription, domain } = await populate();
    const env = await exportRegistry(prisma, KEY);
    expect(env.counts).toMatchObject({ tenants: 1, subscriptions: 1, domains: 1, licenseKeys: 1 });
    expect(env.counts.auditLog).toBeGreaterThan(2);

    const restored = await importRegistry(JSON.parse(JSON.stringify(env)), target, KEY);
    expect(restored).toBe(env.counts.auditLog);

    const original = await readRegistry(prisma);
    const copy = await readRegistry(target);
    expect(copy.tenants).toEqual(original.tenants);
    // El contador de snapshots salta un margen: los fronts rechazan un seq menor que el último visto, y la copia es anterior.
    expect(copy.subscriptions).toEqual(original.subscriptions.map((sub) => ({ ...sub, snapshotSeq: (sub.snapshotSeq as number) + RESTORE_SEQ_MARGIN })));
    expect((copy.subscriptions[0] as { snapshotSeq: number }).snapshotSeq).toBeGreaterThanOrEqual(RESTORE_SEQ_MARGIN);
    expect(copy.domains).toEqual(original.domains);
    expect(copy.licenseKeys).toEqual(original.licenseKeys);
    expect(copy.auditLog).toEqual(original.auditLog);
    expect((copy.subscriptions[0] as { dbUrlPooledEnc: string }).dbUrlPooledEnc).toMatch(/^enc:v2:/);
    expect(copy.domains[0]).toMatchObject({ id: domain.id, subscriptionId: subscription.id });
    expect(verifyDumpAuditChain(copy.auditLog).ok).toBe(true);

    // La secuencia sigue tras el último id: una entrada nueva en la BD restaurada encadena bien.
    await target.$executeRawUnsafe(`SELECT 1`);
    const last = copy.auditLog[copy.auditLog.length - 1] as { id: bigint };
    const seq = await target.$queryRawUnsafe<{ next: bigint }[]>(`SELECT nextval(pg_get_serial_sequence('"AuditLog"', 'id')) AS next`);
    expect(seq[0].next).toBe(last.id + 1n);
  });

  it('el fichero no contiene nada legible: ni URLs de BD ni nombres de clientes', async () => {
    const { subscription } = await populate();
    const text = JSON.stringify(await exportRegistry(prisma, KEY));
    expect(text).not.toMatch(/postgres|secreto-pooled|Cliente /);
    expect(subscription.id).toBeTruthy();
  });

  it('con otra clave, o con el fichero alterado, no abre (GCM)', async () => {
    await populate();
    const env = await exportRegistry(prisma, KEY);
    const other = Buffer.from(parseMasterKey(generateMasterKey()));
    expect(() => openDump(env, other)).toThrow(/no se pudo descifrar/i);
    expect(() => openDump({ ...env, createdAt: '2000-01-01T00:00:00.000Z' }, KEY)).toThrow(/no se pudo descifrar/i);
    const flipped = Buffer.from(env.ct, 'base64url');
    flipped[10] ^= 1;
    expect(() => openDump({ ...env, ct: flipped.toString('base64url') }, KEY)).toThrow(/no se pudo descifrar/i);
    expect(() => openDump({ nada: 1 }, KEY)).toThrow(/no es un fichero/i);
  });

  it('no restaura sobre una BD que ya tiene clientes o auditoría', async () => {
    await populate();
    const env = await exportRegistry(prisma, KEY);
    await expect(importRegistry(env, prisma, KEY)).rejects.toThrow(/no está vacía/);
  });

  it('una auditoría manipulada dentro del fichero se detecta antes de restaurar nada', async () => {
    await populate();
    const { dump, createdAt } = { dump: await readRegistry(prisma), createdAt: new Date().toISOString() };
    (dump.auditLog[1] as { action: string }).action = 'tenant.delete';
    const { sealDump } = await import('@/lib/services/registry-export');
    const forged = sealDump(dump, KEY, new Date(createdAt));
    const empty = await freshControlDb();
    await expect(importRegistry(forged, empty, KEY)).rejects.toThrow(/auditoría del fichero está alterada/);
    expect(await empty.tenant.count()).toBe(0);
    await empty.$disconnect();
    // La auditoría real de la BD sigue íntegra.
    expect((await verifyAuditChain()).ok).toBe(true);
  }, 120_000);

  it('sin REGISTRY_EXPORT_KEY configurada falla con un mensaje claro', async () => {
    const saved = process.env.REGISTRY_EXPORT_KEY;
    delete process.env.REGISTRY_EXPORT_KEY;
    await expect(exportRegistry(prisma)).rejects.toThrow(/REGISTRY_EXPORT_KEY/);
    if (saved) process.env.REGISTRY_EXPORT_KEY = saved;
  });
});
