import { describe, it, expect, beforeEach } from 'vitest';
import { isUlid } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import { openField } from '@/lib/secrets-store';
import { ForbiddenError } from '@/lib/permissions';
import { ServiceError } from '@/lib/services/errors';
import { bumpEpoch, createTenant, replaceDatabaseUrls, setModules, setTenantStatus } from '@/lib/services/tenants';
import { makeOperator, resetControlDb, tenantInput } from './helpers';

beforeEach(resetControlDb);

describe('createTenant', () => {
  it('crea cliente, suscripción, módulos (con núcleo) y dominio pendiente, con las URLs de BD selladas', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const input = tenantInput({ modules: ['tienda', 'entradas'] });
    const { tenant, subscription, domain } = await createTenant(input, actor);

    expect(isUlid(tenant.id)).toBe(true);
    expect(domain.status).toBe('PENDING');
    expect(domain.host).toBe(input.primaryHost);

    const mods = await prisma.subscriptionModule.findMany({ where: { subscriptionId: subscription.id } });
    expect(mods.map((m) => m.moduleKey).sort()).toEqual(['entradas', 'nucleo', 'tienda']);

    // Nunca en claro en la BD de control, y se recuperan con el contexto correcto.
    expect(subscription.dbUrlPooledEnc.startsWith('enc:v2:')).toBe(true);
    expect(subscription.dbUrlPooledEnc).not.toContain('postgresql');
    expect(await openField(subscription.dbUrlPooledEnc, { scope: tenant.id, field: 'db_url_pooled' })).toBe(input.dbUrlPooled);
    await expect(openField(subscription.dbUrlPooledEnc, { scope: tenant.id, field: 'db_url_direct' })).rejects.toThrow();
  });

  it('deja una entrada de auditoría sin URLs ni secretos', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const { tenant } = await createTenant(tenantInput(), actor);
    const entry = await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'tenant.create' } });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.meta)).not.toMatch(/postgres|enc:v|secreto/);
    expect(entry!.operatorEmail).toBe(actor.email);
  });

  it.each([
    ['nombre corto', { name: 'x' }, 'invalid_name'],
    ['host con ruta', { primaryHost: 'evil.com/x' }, 'invalid_host'],
    ['host con mayúsculas y esquema', { primaryHost: 'https://Cliente.es' }, 'invalid_host'],
    ['URL de BD mala', { dbUrlPooled: 'mysql://x/y' }, 'invalid_database_url'],
    ['URL de BD vacía', { dbUrlDirect: '' }, 'invalid_database_url'],
    ['BD remota sin TLS', { dbUrlPooled: 'postgresql://u:p@ep-x.neon.tech/db' }, 'insecure_database_url'],
    ['BD remota con sslmode=disable', { dbUrlDirect: 'postgresql://u:p@ep-x.neon.tech/db?sslmode=disable' }, 'insecure_database_url'],
    ['módulo inexistente', { modules: ['inventado'] }, 'unknown_module'],
    ['producto inexistente', { productKey: 'otro' }, 'unknown_product'],
  ])('rechaza: %s', async (_label, over, code) => {
    const { actor } = await makeOperator('SUPERADMIN');
    await expect(createTenant(tenantInput(over), actor)).rejects.toMatchObject({ code });
    expect(await prisma.tenant.count()).toBe(0);
  });

  it('un OPERATOR, un VIEWER o un BILLING no pueden crear clientes (crear fija la BD: exige database:write)', async () => {
    for (const role of ['OPERATOR', 'VIEWER', 'BILLING'] as const) {
      const { actor } = await makeOperator(role);
      await expect(createTenant(tenantInput(), actor)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await prisma.tenant.count()).toBe(0);
  });

  it('un dominio ya usado impide crear el cliente y no deja restos', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const a = tenantInput();
    await createTenant(a, actor);
    await expect(createTenant(tenantInput({ primaryHost: a.primaryHost }), actor)).rejects.toMatchObject({ code: 'domain_taken' });
    expect(await prisma.tenant.count()).toBe(1);
  });
});

describe('módulos, estado y época', () => {
  it('Wallets sin Entradas se rechaza: solo emite pases de entradas, sería un módulo cobrado sin función', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    await expect(createTenant(tenantInput({ modules: ['tienda', 'wallets'] }), actor)).rejects.toMatchObject({ code: 'module_requires' });
    const { subscription } = await createTenant(tenantInput({ modules: ['tienda'] }), actor);
    await expect(setModules(subscription.id, ['tienda', 'wallets'], actor)).rejects.toMatchObject({ code: 'module_requires' });
    await expect(setModules(subscription.id, ['entradas', 'wallets'], actor)).resolves.toBeTruthy();
  });

  it('setModules añade y quita, y no deja quitar el núcleo', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const { subscription } = await createTenant(tenantInput({ modules: ['tienda'] }), actor);
    const r = await setModules(subscription.id, ['entradas', 'wallets'], actor);
    expect(r).toEqual({ added: ['entradas', 'wallets'], removed: ['tienda'] });
    const keys = (await prisma.subscriptionModule.findMany({ where: { subscriptionId: subscription.id } })).map((m) => m.moduleKey).sort();
    expect(keys).toEqual(['entradas', 'nucleo', 'wallets']);
    await setModules(subscription.id, [], actor);
    expect((await prisma.subscriptionModule.findMany({ where: { subscriptionId: subscription.id } })).map((m) => m.moduleKey)).toEqual(['nucleo']);
    await expect(setModules(subscription.id, ['nope'], actor)).rejects.toBeInstanceOf(ServiceError);
  });

  it('un cambio sin diferencias no escribe auditoría', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const { subscription, tenant } = await createTenant(tenantInput({ modules: ['tienda'] }), actor);
    const before = await prisma.auditLog.count({ where: { tenantId: tenant.id } });
    await setModules(subscription.id, ['tienda'], actor);
    expect(await prisma.auditLog.count({ where: { tenantId: tenant.id } })).toBe(before);
  });

  it('suspende y reactiva un cliente, y sube la época', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const { tenant, subscription } = await createTenant(tenantInput(), actor);
    expect((await setTenantStatus(tenant.id, 'SUSPENDED', actor)).status).toBe('SUSPENDED');
    expect((await setTenantStatus(tenant.id, 'ACTIVE', actor)).status).toBe('ACTIVE');
    expect((await bumpEpoch(subscription.id, actor)).epoch).toBe(1);
  });
});

describe('replaceDatabaseUrls', () => {
  it('solo SUPERADMIN, y no deja las URLs en la auditoría', async () => {
    const { actor: op } = await makeOperator('OPERATOR');
    const { actor: root } = await makeOperator('SUPERADMIN');
    const { subscription, tenant } = await createTenant(tenantInput(), root);
    const urls = { pooled: 'postgresql://n:nuevo@h/db?sslmode=require', direct: 'postgresql://n:nuevo@h2/db?sslmode=require', schemaVersion: '20261008_x' };
    await expect(replaceDatabaseUrls(subscription.id, urls, op)).rejects.toBeInstanceOf(ForbiddenError);
    await replaceDatabaseUrls(subscription.id, urls, root);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(await openField(sub.dbUrlPooledEnc, { scope: tenant.id, field: 'db_url_pooled' })).toBe(urls.pooled);
    expect(sub.schemaVersion).toBe('20261008_x');
    const entry = await prisma.auditLog.findFirst({ where: { action: 'subscription.replace_database_urls', tenantId: tenant.id } });
    expect(JSON.stringify(entry!.meta)).toBe('{}');
  });
});

describe('URLs de BD locales', () => {
  it('una BD en localhost se acepta sin TLS (desarrollo)', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const res = await createTenant(tenantInput({ dbUrlPooled: 'postgresql://u:p@localhost:5432/db', dbUrlDirect: 'postgresql://u:p@127.0.0.1:5432/db' }), actor);
    expect(res.tenant.id).toBeTruthy();
  });
});
