import { beforeEach, describe, expect, it } from 'vitest';
import { registryKeyForHost, registryKeyForRevocation, registryKeyForSecrets } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import { listTenants } from '@/lib/queries';
import { ForbiddenError } from '@/lib/permissions';
import type { RegistryStore } from '@/lib/registry/store';
import { verifyDomainManually } from '@/lib/services/domains';
import { refreshAllSnapshots } from '@/lib/services/license';
import { retireTenant } from '@/lib/services/retire';
import { publishSubscription } from '@/lib/services/snapshot';
import { createTenant, setTenantStatus } from '@/lib/services/tenants';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';

beforeEach(resetControlDb);

/** Un cliente publicado, con salud y estado de crons, suspendido y listo para retirar. */
async function suspendedPublished(name = 'Cliente de ensayo') {
  const { actor } = await makeOperator('SUPERADMIN');
  const input = tenantInput({ name });
  const t = await createTenant(input as never, actor);
  await verifyDomainManually(t.domain.id, actor);
  const store = freshStore();
  await publishSubscription(t.subscription.id, actor, store);
  await prisma.tenantHealth.create({ data: { subscriptionId: t.subscription.id, checkedAt: new Date(), ok: true, status: 'ok' } });
  await prisma.cronState.create({ data: { subscriptionId: t.subscription.id, job: 'health' } });
  await setTenantStatus(t.tenant.id, 'SUSPENDED', actor);
  return { actor, input, store, ...t };
}

describe('retirar un cliente', () => {
  it('exige superadmin, estar suspendido y escribir el nombre exacto; y no cambia nada si falla', async () => {
    const t = await suspendedPublished('Peña La Grailla');
    const { actor: operator } = await makeOperator('OPERATOR');
    await expect(retireTenant(t.tenant.id, { confirmName: 'Peña La Grailla' }, operator, t.store)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(retireTenant(t.tenant.id, { confirmName: 'peña la grailla' }, t.actor, t.store)).rejects.toMatchObject({ code: 'confirm_mismatch' });
    await expect(retireTenant(t.tenant.id, { confirmName: '' }, t.actor, t.store)).rejects.toMatchObject({ code: 'confirm_mismatch' });
    await setTenantStatus(t.tenant.id, 'ACTIVE', t.actor);
    await expect(retireTenant(t.tenant.id, { confirmName: 'Peña La Grailla' }, t.actor, t.store)).rejects.toMatchObject({ code: 'suspend_first' });
    await expect(retireTenant('no-existe', { confirmName: 'x' }, t.actor, t.store)).rejects.toMatchObject({ code: 'not_found' });
    // Nada de lo anterior ha tocado el registro ni el panel.
    expect(await t.store.get(registryKeyForHost(t.domain.host))).not.toBeNull();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenant.id } })).status).toBe('ACTIVE');
  });

  it('borra del registro dominios, URLs selladas y revocación; y deja el panel limpio', async () => {
    const t = await suspendedPublished('Ensayo runner');
    expect(await t.store.get(registryKeyForSecrets(t.tenant.id, 'grailla'))).not.toBeNull();
    await t.store.put(registryKeyForRevocation(t.tenant.id), String(Date.now()));

    const res = await retireTenant(t.tenant.id, { confirmName: 'Ensayo runner' }, t.actor, t.store);
    expect(res).toMatchObject({ alreadyRetired: false, hosts: [t.domain.host] });

    expect(await t.store.get(registryKeyForHost(t.domain.host))).toBeNull();
    expect(await t.store.get(registryKeyForSecrets(t.tenant.id, 'grailla'))).toBeNull();
    expect(await t.store.get(registryKeyForRevocation(t.tenant.id))).toBeNull();

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenant.id }, include: { subscriptions: { include: { domains: true, health: true, cronStates: true } } } });
    expect(tenant.status).toBe('DELETED');
    const [sub] = tenant.subscriptions;
    expect(sub).toMatchObject({ dbUrlPooledEnc: '', dbUrlDirectEnc: '', dbFingerprint: null, lastPublishedAt: null, lastPublishedHash: null });
    expect(sub.health).toBeNull();
    expect(sub.cronStates).toHaveLength(0);
    // El dominio queda como lápida: liberado y sin ser el principal.
    expect(sub.domains[0]).toMatchObject({ status: 'RELEASED', isPrimary: false });
    expect(sub.domains[0].releasedAt).not.toBeNull();
  });

  it('deja de aparecer en la lista, en el refresco de snapshots y no se puede publicar', async () => {
    const keep = await suspendedPublished('Cliente que se queda');
    await setTenantStatus(keep.tenant.id, 'ACTIVE', keep.actor);
    const gone = await suspendedPublished('Cliente que se va');
    await retireTenant(gone.tenant.id, { confirmName: 'Cliente que se va' }, gone.actor, gone.store);

    expect((await listTenants()).map((r) => r.tenant.name)).toEqual(['Cliente que se queda']);
    const refreshed = await refreshAllSnapshots(keep.actor, keep.store);
    expect(refreshed).toMatchObject({ published: 1, failed: [] });
    await expect(publishSubscription(gone.subscription.id, gone.actor, gone.store)).rejects.toMatchObject({ code: 'invalid_state' });
    // Y la web que se queda sigue en el registro.
    expect(await keep.store.get(registryKeyForHost(keep.domain.host))).not.toBeNull();
  });

  it('la BD de un cliente retirado puede volver a registrarse (la huella queda libre)', async () => {
    const t = await suspendedPublished('Ensayo aplicar');
    await retireTenant(t.tenant.id, { confirmName: 'Ensayo aplicar' }, t.actor, t.store);
    const again = await createTenant(tenantInput({ name: 'Cliente real', dbUrlPooled: t.input.dbUrlPooled, dbUrlDirect: t.input.dbUrlDirect }) as never, t.actor);
    expect(again.tenant.status).toBe('ACTIVE');
  });

  it('es repetible: retirar otra vez no falla ni cambia nada', async () => {
    const t = await suspendedPublished('Ensayo repetido');
    await retireTenant(t.tenant.id, { confirmName: 'Ensayo repetido' }, t.actor, t.store);
    const again = await retireTenant(t.tenant.id, { confirmName: 'cualquier cosa' }, t.actor, t.store);
    expect(again.alreadyRetired).toBe(true);
    expect(await prisma.auditLog.count({ where: { tenantId: t.tenant.id, action: 'tenant.retire' } })).toBe(1);
  });

  it('si el registro falla, el panel no cambia y se puede repetir', async () => {
    const t = await suspendedPublished('Ensayo con fallo');
    const broken: RegistryStore = { put: async () => {}, get: async () => null, del: async () => { throw new Error('upstash caído'); } };
    await expect(retireTenant(t.tenant.id, { confirmName: 'Ensayo con fallo' }, t.actor, broken)).rejects.toMatchObject({ code: 'registry_unavailable' });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t.tenant.id }, include: { subscriptions: true } });
    expect(tenant.status).toBe('SUSPENDED');
    expect(tenant.subscriptions[0].dbUrlDirectEnc).not.toBe('');
    await expect(retireTenant(t.tenant.id, { confirmName: 'Ensayo con fallo' }, t.actor, t.store)).resolves.toMatchObject({ alreadyRetired: false });
  });

  it('deja constancia en la auditoría con el nombre y los dominios, sin URLs de BD', async () => {
    const t = await suspendedPublished('Ensayo auditado');
    await retireTenant(t.tenant.id, { confirmName: 'Ensayo auditado' }, t.actor, t.store);
    const [row] = await prisma.auditLog.findMany({ where: { tenantId: t.tenant.id, action: 'tenant.retire' } });
    expect(row.meta).toMatchObject({ name: 'Ensayo auditado', from: 'SUSPENDED', subscriptions: 1, hosts: [t.domain.host] });
    expect(JSON.stringify(row.meta)).not.toMatch(/postgres|enc:v/);
  });
});
