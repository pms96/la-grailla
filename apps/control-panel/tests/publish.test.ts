import { describe, it, expect, beforeEach } from 'vitest';
import { DB_URL_POOLED_FIELD, parseMasterKey, openSecret, registryKeyForHost, registryKeyForSecrets, verifySecretsSnapshot, verifySnapshot, RoutingRecordSchema } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/permissions';
import type { RegistryStore } from '@/lib/registry/store';
import { addDomain, releaseDomain, setPrimaryDomain, verifyDomainManually } from '@/lib/services/domains';
import { loadSubscription, pendingChanges, publishSubscription, republishIfPublished } from '@/lib/services/snapshot';
import { setModules, setTenantStatus } from '@/lib/services/tenants';
import { DB_URLS, freshStore, makeOperator, resetControlDb, signerPublicKey, tenantInput, uniq, rootCreateTenant } from './helpers';

beforeEach(resetControlDb);

async function verifiedTenant(modules = ['tienda']) {
  const { actor } = await makeOperator('OPERATOR');
  const { actor: root } = await makeOperator('SUPERADMIN');
  const t = await rootCreateTenant(tenantInput({ modules }));
  await verifyDomainManually(t.domain.id, root);
  return { actor, root, ...t, store: freshStore() };
}

async function read(store: { get(k: string): Promise<string | null> }, host: string) {
  const raw = await store.get(registryKeyForHost(host));
  return raw ? JSON.parse(raw) : null;
}

describe('publicar el registro', () => {
  it('no publica sin ningún dominio verificado', async () => {
    const { actor } = await makeOperator('OPERATOR');
    const t = await rootCreateTenant(tenantInput());
    freshStore();
    await expect(publishSubscription(t.subscription.id, actor)).rejects.toMatchObject({ code: 'no_verified_domain' });
  });

  it('escribe un snapshot firmado y verificable por cada dominio, sin ningún secreto', async () => {
    const { actor, subscription, tenant, domain, store } = await verifiedTenant(['tienda', 'entradas']);
    const res = await publishSubscription(subscription.id, actor, store);
    expect(res.seq).toBe(1);

    const envelope = await read(store, domain.host);
    const keys = { stest: await signerPublicKey() };
    const verified = await verifySnapshot(envelope, { keys, host: domain.host, now: Date.now() });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(RoutingRecordSchema.safeParse(verified.body.record).success).toBe(true);
    expect(verified.body.record).toMatchObject({
      tenantId: tenant.id,
      primaryDomain: domain.host,
      domains: [domain.host],
      modules: ['entradas', 'nucleo', 'tienda'],
      status: 'ACTIVE',
      license: { phase: 'ACTIVE' },
    });
    expect(verified.stale).toBe(false);
    // Nada de BD ni de claves en lo publicado.
    expect(envelope.payload).not.toMatch(/postgres|enc:v2|secreto|password/i);
  });

  it('cada publicación sube el seq y un snapshot viejo se detecta como replay', async () => {
    const { actor, subscription, domain, store } = await verifiedTenant();
    const keys = { stest: await signerPublicKey() };
    await publishSubscription(subscription.id, actor, store);
    const first = await read(store, domain.host);
    const res = await publishSubscription(subscription.id, actor, store);
    expect(res.seq).toBe(2);
    expect(await verifySnapshot(first, { keys, host: domain.host, now: Date.now(), lastSeq: 2 })).toEqual({ ok: false, reason: 'replay' });
  });

  it('detecta cambios sin publicar y los limpia al publicar', async () => {
    const { actor, subscription, store } = await verifiedTenant(['tienda']);
    expect(pendingChanges(await loadSubscription(prisma, subscription.id))).toBe(true);
    await publishSubscription(subscription.id, actor, store);
    expect(pendingChanges(await loadSubscription(prisma, subscription.id))).toBe(false);
    await setModules(subscription.id, ['tienda', 'wallets'], actor);
    expect(pendingChanges(await loadSubscription(prisma, subscription.id))).toBe(true);
    await publishSubscription(subscription.id, actor, store);
    expect(pendingChanges(await loadSubscription(prisma, subscription.id))).toBe(false);
  });

  it('suspender un cliente se refleja en el estado publicado', async () => {
    const { actor, subscription, tenant, domain, store } = await verifiedTenant();
    await setTenantStatus(tenant.id, 'SUSPENDED', actor);
    await publishSubscription(subscription.id, actor, store);
    const v = await verifySnapshot(await read(store, domain.host), { keys: { stest: await signerPublicKey() }, host: domain.host, now: Date.now() });
    expect(v.ok && v.body.record.status).toBe('SUSPENDED');
  });

  it('publica en todos los dominios verificados y retira los liberados', async () => {
    const { actor, root, subscription, domain, store } = await verifiedTenant();
    const second = await addDomain(subscription.id, `segundo-${uniq()}.es`, actor);
    await verifyDomainManually(second.id, root);
    await setPrimaryDomain(second.id, actor);
    await publishSubscription(subscription.id, actor, store);
    expect(await read(store, domain.host)).not.toBeNull();
    expect(await read(store, second.host)).not.toBeNull();

    await releaseDomain(domain.id, actor);
    await publishSubscription(subscription.id, actor, store);
    expect(await read(store, domain.host)).toBeNull();
    expect(await read(store, second.host)).not.toBeNull();
  });

  it('un dominio pendiente (no verificado) no se publica', async () => {
    const { actor, subscription, store } = await verifiedTenant();
    const pending = await addDomain(subscription.id, `pendiente-${uniq()}.es`, actor);
    await publishSubscription(subscription.id, actor, store);
    expect(await read(store, pending.host)).toBeNull();
  });

  it('si el almacén falla se anota el error, se consume el seq y se avisa; el siguiente intento funciona', async () => {
    const { actor, subscription, store } = await verifiedTenant();
    let fail = true;
    const flaky: RegistryStore = {
      put: async (k, v) => {
        if (fail) throw new Error('503 del registro');
        return store.put(k, v);
      },
      del: (k) => store.del(k),
      get: (k) => store.get(k),
    };
    await expect(publishSubscription(subscription.id, actor, flaky)).rejects.toMatchObject({ code: 'registry_unavailable' });
    let sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(sub.lastPublishError).toContain('503');
    expect(sub.lastPublishedHash).toBeNull();
    expect(sub.snapshotSeq).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'subscription.publish_failed', tenantId: sub.tenantId } })).toBe(1);

    fail = false;
    const ok = await publishSubscription(subscription.id, actor, flaky);
    expect(ok.seq).toBe(2);
    sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(sub.lastPublishError).toBeNull();
  });

  it('dos publicaciones simultáneas no dejan un seq viejo por encima de uno nuevo', async () => {
    const { actor, subscription, domain, store } = await verifiedTenant();
    const slowFirst: RegistryStore = {
      // La primera escritura tarda más: sin serializar, acabaría escribiéndose DESPUÉS de la segunda.
      put: async (k, v) => {
        const seq = JSON.parse(JSON.parse(v).payload).seq;
        if (seq === 1) await new Promise((r) => setTimeout(r, 150));
        return store.put(k, v);
      },
      del: (k) => store.del(k),
      get: (k) => store.get(k),
    };
    const [a, b] = await Promise.all([publishSubscription(subscription.id, actor, slowFirst), publishSubscription(subscription.id, actor, slowFirst)]);
    expect([a.seq, b.seq].sort()).toEqual([1, 2]);
    const stored = JSON.parse(JSON.parse((await store.get(registryKeyForHost(domain.host)))!).payload);
    expect(stored.seq).toBe(2);
  });

  it('un VIEWER no puede publicar', async () => {
    const { subscription, store } = await verifiedTenant();
    const { actor: viewer } = await makeOperator('VIEWER');
    await expect(publishSubscription(subscription.id, viewer, store)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('registro de secretos', () => {
  it('publica las URLs de BD selladas, firmadas y atadas al cliente y al producto', async () => {
    const { actor, subscription, tenant, store } = await verifiedTenant();
    await publishSubscription(subscription.id, actor, store);
    const raw = await store.get(registryKeyForSecrets(tenant.id, 'grailla'));
    expect(raw).not.toBeNull();
    const keys = { stest: await signerPublicKey() };
    const res = await verifySecretsSnapshot(JSON.parse(raw!), { keys, tenantId: tenant.id, product: 'grailla' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(raw).not.toMatch(/postgres(ql)?:\/\//);
    // El front las abre con la clave maestra y el mismo contexto (tenant + campo).
    const masters = JSON.parse(process.env.SECRETS_KEYS!) as Record<string, string>;
    const url = await openSecret(res.body.dbUrlPooledEnc, { tenantId: tenant.id, field: DB_URL_POOLED_FIELD }, parseMasterKey(masters[process.env.SECRETS_ACTIVE_KID!]));
    expect(url).toBe(DB_URLS.dbUrlPooled);
    expect(res.body.seq).toBe(1);
  });

  it('el secreto de un cliente no verifica como el de otro', async () => {
    const a = await verifiedTenant();
    const b = await verifiedTenant();
    await publishSubscription(a.subscription.id, a.actor, a.store);
    const raw = await a.store.get(registryKeyForSecrets(a.tenant.id, 'grailla'));
    const keys = { stest: await signerPublicKey() };
    expect(await verifySecretsSnapshot(JSON.parse(raw!), { keys, tenantId: b.tenant.id, product: 'grailla' })).toEqual({ ok: false, reason: 'tenant_mismatch' });
  });

  it('si falla el almacén al escribir los secretos no se publica ningún enrutado', async () => {
    const { actor, subscription, domain, store } = await verifiedTenant();
    const failSecrets: RegistryStore = {
      put: async (k, v) => {
        if (k.startsWith('s:')) throw new Error('registro caído');
        return store.put(k, v);
      },
      del: (k) => store.del(k),
      get: (k) => store.get(k),
    };
    await expect(publishSubscription(subscription.id, actor, failSecrets)).rejects.toMatchObject({ code: 'registry_unavailable' });
    expect(await store.get(registryKeyForHost(domain.host))).toBeNull();
  });
});

describe('cambios que se aplican ya', () => {
  it('suspender y volver a publicar deja el registro en SUSPENDED sin pulsar "Publicar"', async () => {
    const { actor, subscription, tenant, domain, store } = await verifiedTenant();
    await publishSubscription(subscription.id, actor, store);
    await setTenantStatus(tenant.id, 'SUSPENDED', actor);
    const errors = await republishIfPublished(tenant.id, actor, store);
    expect(errors).toEqual([]);
    const v = await verifySnapshot(await read(store, domain.host), { keys: { stest: await signerPublicKey() }, host: domain.host, now: Date.now() });
    expect(v.ok && v.body.record.status).toBe('SUSPENDED');
  });

  it('liberar un dominio retira su entrada del registro al instante', async () => {
    const { actor, root, subscription, tenant, domain, store } = await verifiedTenant();
    const second = await addDomain(subscription.id, `segundo-${uniq()}.es`, actor);
    await verifyDomainManually(second.id, root);
    await setPrimaryDomain(second.id, actor);
    await publishSubscription(subscription.id, actor, store);
    expect(await read(store, domain.host)).not.toBeNull();
    await releaseDomain(domain.id, actor);
    expect(await republishIfPublished(tenant.id, actor, store)).toEqual([]);
    expect(await read(store, domain.host)).toBeNull();
  });

  it('no republica clientes que nunca se publicaron', async () => {
    const { actor, tenant, store } = await verifiedTenant();
    expect(await republishIfPublished(tenant.id, actor, store)).toEqual([]);
    expect(store.data.size).toBe(0);
  });

  it('si el registro falla devuelve el error en vez de ocultarlo', async () => {
    const { actor, subscription, tenant, store } = await verifiedTenant();
    await publishSubscription(subscription.id, actor, store);
    const broken: RegistryStore = { put: async () => { throw new Error('registro caído'); }, del: async () => {}, get: async () => null };
    const errors = await republishIfPublished(tenant.id, actor, broken);
    expect(errors.join(' ')).toContain('registro caído');
  });
});
