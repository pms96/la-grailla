import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { databaseFingerprint } from '@/lib/services/db-identity';
import { createTenant, replaceDatabaseUrls } from '@/lib/services/tenants';
import { dbUrlsFor, makeOperator, resetControlDb, tenantInput, uniq } from './helpers';

/* Cada cliente tiene SU base de datos. Si dos compartieran una (un copia-pega equivocado de las URLs de Neon), verían los datos del otro. */

beforeEach(resetControlDb);

describe('dar de alta un cliente', () => {
  it('con la BD de otro cliente se rechaza, y no queda nada a medias', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = tenantInput();
    await createTenant(a, actor);
    const b = tenantInput({ dbUrlPooled: a.dbUrlPooled, dbUrlDirect: a.dbUrlDirect });
    await expect(createTenant(b, actor)).rejects.toMatchObject({ code: 'database_in_use' });
    expect(await prisma.tenant.count()).toBe(1);
    expect(await prisma.domain.findUnique({ where: { host: b.primaryHost } })).toBeNull();
  });

  it('la misma BD con la URL directa en el lugar de la del pooler cuenta como la misma', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = tenantInput();
    await createTenant(a, actor);
    const b = tenantInput({ dbUrlPooled: a.dbUrlDirect, dbUrlDirect: a.dbUrlDirect });
    await expect(createTenant(b, actor)).rejects.toMatchObject({ code: 'database_in_use' });
  });

  it('con la URL con pooler de un servidor y la directa de otro se rechaza (un copia-pega a medias)', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const mixed = tenantInput({ dbUrlPooled: dbUrlsFor(`otro${uniq()}`).dbUrlPooled });
    await expect(createTenant(mixed, actor)).rejects.toMatchObject({ code: 'database_mismatch' });
    expect(await prisma.tenant.count()).toBe(0);
  });

  it('clientes con BD distintas no se molestan', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    await createTenant(tenantInput(), actor);
    await createTenant(tenantInput(), actor);
    expect(await prisma.subscription.count({ where: { dbFingerprint: { not: null } } })).toBe(2);
  });

  it('un cliente anterior a la huella (sin huella guardada) también cuenta: se calcula al comprobar', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = tenantInput();
    const { subscription } = await createTenant(a, actor);
    await prisma.subscription.update({ where: { id: subscription.id }, data: { dbFingerprint: null } });

    const b = tenantInput({ dbUrlPooled: a.dbUrlPooled, dbUrlDirect: a.dbUrlDirect });
    await expect(createTenant(b, actor)).rejects.toMatchObject({ code: 'database_in_use' });
    // y de paso se le ha puesto la huella al antiguo
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.dbFingerprint).toBe(databaseFingerprint(a.dbUrlDirect));
  });

  it('dos altas SIMULTÁNEAS con la misma BD: solo una se queda (el índice único lo garantiza)', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const urls = dbUrlsFor(`carrera${uniq()}`);
    const results = await Promise.allSettled([createTenant(tenantInput(urls), actor), createTenant(tenantInput(urls), actor)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'database_in_use' });
    expect(await prisma.tenant.count()).toBe(1);
  });
});

describe('sustituir las URLs de un cliente', () => {
  it('no se puede apuntar a la BD de OTRO cliente', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = tenantInput();
    const b = tenantInput();
    await createTenant(a, actor);
    const { subscription: subB } = await createTenant(b, actor);
    await expect(replaceDatabaseUrls(subB.id, { pooled: a.dbUrlPooled, direct: a.dbUrlDirect }, actor)).rejects.toMatchObject({ code: 'database_in_use' });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subB.id } });
    expect(after.dbFingerprint).toBe(databaseFingerprint(b.dbUrlDirect)); // sin cambios
  });

  it('repetir con sus propias URLs (rotar la contraseña, por ejemplo) sí vale', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = tenantInput();
    const { subscription } = await createTenant(a, actor);
    await expect(
      replaceDatabaseUrls(subscription.id, { pooled: a.dbUrlPooled.replace('secreto-pooled', 'nueva'), direct: a.dbUrlDirect.replace('secreto-directo', 'nueva') }, actor)
    ).resolves.not.toThrow();
  });

  it('mover a una BD nueva actualiza la huella, y la antigua queda libre para otro cliente', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = tenantInput();
    const { subscription } = await createTenant(a, actor);
    const nueva = dbUrlsFor(`nueva${uniq()}`);
    await replaceDatabaseUrls(subscription.id, { pooled: nueva.dbUrlPooled, direct: nueva.dbUrlDirect }, actor);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.dbFingerprint).toBe(databaseFingerprint(nueva.dbUrlDirect));
    await expect(createTenant(tenantInput({ dbUrlPooled: a.dbUrlPooled, dbUrlDirect: a.dbUrlDirect }), actor)).resolves.toBeTruthy();
  });

  it('un pooler y una directa de servidores distintos se rechazan', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const { subscription } = await createTenant(tenantInput(), actor);
    const x = dbUrlsFor(`x${uniq()}`);
    const y = dbUrlsFor(`y${uniq()}`);
    await expect(replaceDatabaseUrls(subscription.id, { pooled: x.dbUrlPooled, direct: y.dbUrlDirect }, actor)).rejects.toMatchObject({ code: 'database_mismatch' });
  });
});
