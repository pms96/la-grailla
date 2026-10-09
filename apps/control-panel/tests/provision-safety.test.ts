import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { provisionTenant, type ProvisionInput } from '@/lib/services/provision';
import { createTenant, replaceDatabaseUrls } from '@/lib/services/tenants';
import { freshStore, makeOperator, resetControlDb, tenantInput, uniq } from './helpers';
import { dropScratchDb, queryScratch, scratchUrl } from './scratch-db';

/* Un alta sembraba un administrador con contraseña conocida en la BD que le dieran. Con una URL equivocada (la de otro cliente, la de producción
 * de La Grailla) eso es un acceso de administrador a datos ajenos. Ahora una BD con datos o de otro cliente se rechaza ANTES de tocar nada. */

const created: string[] = [];
const LEGAL = { legal_notice: 'Aviso legal del cliente.', privacy_policy: 'Política de privacidad del cliente.', cookies_policy: 'Política de cookies del cliente.' };

function input(over: Partial<ProvisionInput> = {}): ProvisionInput {
  const id = uniq();
  const dbName = `lagrailla_scratch_safe_${id}`.slice(0, 60);
  created.push(dbName);
  return {
    name: `Cliente ${id}`,
    primaryHost: `seguro-${id}.localhost`,
    modules: ['tienda'],
    adminEmail: `dueno-${id}@cliente.test`,
    legal: LEGAL,
    database: { mode: 'local', name: dbName },
    domain: 'manual',
    ...over,
  };
}
const dbNameOf = (i: ProvisionInput) => (i.database as { name: string }).name;

beforeEach(async () => {
  freshStore();
  await resetControlDb();
});
afterAll(async () => {
  for (const name of created) await dropScratchDb(name);
}, 60_000);

describe('la BD queda marcada con el cliente al que pertenece', () => {
  it('al sembrar, AppConfig lleva platform_tenant_id con el id del cliente', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input();
    const res = await provisionTenant(inp, actor);
    const rows = await queryScratch<{ value: string; group: string }>(dbNameOf(inp), `SELECT "value", "group" FROM "AppConfig" WHERE "key" = 'platform_tenant_id'`);
    expect(rows).toEqual([{ value: res.tenantId, group: 'platform' }]);
  });

  it('repetir el alta del MISMO cliente sigue funcionando (la marca es suya)', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input();
    const first = await provisionTenant(inp, actor);
    const again = await provisionTenant(inp, actor);
    expect(again.tenantId).toBe(first.tenantId);
    expect(again.steps.find((s) => s.step === 'register')?.status).toBe('skipped');
  });
});

describe('una BD que no es nueva se rechaza antes de registrar, migrar o sembrar nada', () => {
  it('marcada como de OTRO cliente: nunca', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = input();
    await provisionTenant(a, actor);
    const tenantsBefore = await prisma.tenant.count();

    const b = input({ database: { mode: 'local', name: dbNameOf(a) } });
    await expect(provisionTenant(b, actor)).rejects.toMatchObject({ code: 'database_belongs_to_other_tenant' });
    // ni siquiera con --adopt-database
    await expect(provisionTenant({ ...b, adoptDatabase: true }, actor)).rejects.toMatchObject({ code: 'database_belongs_to_other_tenant' });

    expect(await prisma.tenant.count()).toBe(tenantsBefore);
    expect(await prisma.domain.findUnique({ where: { host: b.primaryHost } })).toBeNull();
    // y la BD de A no ha cambiado: sigue con un solo administrador
    expect(await queryScratch(dbNameOf(a), `SELECT 1 FROM "User"`)).toHaveLength(1);
  });

  it('con datos y sin marca (p. ej. una BD de producción anterior): se rechaza, salvo --adopt-database', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = input();
    await provisionTenant(a, actor);
    // «Se olvida» el registro y la marca: queda una BD con datos que no es de ningún cliente de la plataforma.
    await resetControlDb();
    const { actor: actor2 } = await makeOperator('SUPERADMIN');
    await queryScratch(dbNameOf(a), `DELETE FROM "AppConfig" WHERE "key" = 'platform_tenant_id' RETURNING 1`);

    const b = input({ database: { mode: 'local', name: dbNameOf(a) } });
    await expect(provisionTenant(b, actor2)).rejects.toMatchObject({ code: 'database_not_empty' });
    expect(await prisma.tenant.count()).toBe(0);
    expect(await queryScratch(dbNameOf(a), `SELECT 1 FROM "User"`)).toHaveLength(1); // no se sembró ningún administrador

    const adopted = await provisionTenant({ ...b, adoptDatabase: true }, actor2);
    expect(adopted.adminPassword).toBeUndefined(); // sus usuarios ya existen: no se crea uno nuevo
    expect(await queryScratch(dbNameOf(a), `SELECT 1 FROM "User"`)).toHaveLength(1);
    const marker = await queryScratch<{ value: string }>(dbNameOf(a), `SELECT "value" FROM "AppConfig" WHERE "key" = 'platform_tenant_id'`);
    expect(marker[0].value).toBe(adopted.tenantId);
  });

  it('una BD vacía (recién creada) se acepta sin más', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const res = await provisionTenant(input(), actor);
    expect(res.ok).toBe(true);
    expect(res.adminPassword).toBeTruthy();
  });
});

describe('sustituir las URLs comprobando la marca', () => {
  it('no deja asignar a un cliente una BD marcada como de otro', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = input();
    await provisionTenant(a, actor);
    await resetControlDb(); // la BD de A queda sin cliente registrado, pero con su marca
    const { actor: actor2 } = await makeOperator('SUPERADMIN');
    const { subscription } = await createTenant(tenantInput(), actor2);

    const url = scratchUrl(dbNameOf(a));
    await expect(replaceDatabaseUrls(subscription.id, { pooled: url, direct: url }, actor2, { checkMarker: true })).rejects.toMatchObject({ code: 'database_belongs_to_other_tenant' });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.dbFingerprint).not.toBeNull();
  });
});
