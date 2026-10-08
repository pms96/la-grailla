import { beforeEach, describe, expect, it } from 'vitest';
import { registryKeyForHost, registryKeyForRevocation, verifySnapshot } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/permissions';
import type { RegistryStore } from '@/lib/registry/store';
import { verifyDomainManually } from '@/lib/services/domains';
import {
  createLicenseKey,
  emergencyRevoke,
  liftEmergencyRevocation,
  licenseStateOf,
  redeemLicenseKey,
  refreshAllSnapshots,
  registerPayment,
  setLicenseTerms,
} from '@/lib/services/license';
import { buildRoutingRecord, loadSubscription, pendingChanges, publishSubscription, republishIfPublished } from '@/lib/services/snapshot';
import { freshStore, makeOperator, resetControlDb, signerPublicKey, tenantInput, rootCreateTenant } from './helpers';

beforeEach(resetControlDb);

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

async function verifiedTenant(modules = ['tienda']) {
  const { actor: root } = await makeOperator('SUPERADMIN');
  const { actor: billing } = await makeOperator('BILLING');
  const { actor: operator } = await makeOperator('OPERATOR');
  const t = await rootCreateTenant(tenantInput({ modules }));
  await verifyDomainManually(t.domain.id, root);
  return { root, billing, operator, ...t, store: freshStore() };
}

const terms = (paidThrough: number | null, graceDays = 7, panelBlockedDays = 15) => ({ paidThrough: paidThrough === null ? null : new Date(paidThrough), graceDays, panelBlockedDays });

describe('licencia en el registro publicado', () => {
  it('sin vigencia fijada el cliente está siempre ACTIVE y sin calendario', async () => {
    const { subscription } = await verifiedTenant();
    const rec = buildRoutingRecord(await loadSubscription(prisma, subscription.id), NOW);
    expect(rec.license).toEqual({ phase: 'ACTIVE', nextPhaseChangeAt: null, schedule: [] });
  });

  it('con vigencia, publica la fase de ahora y el calendario de los cambios futuros', async () => {
    const { subscription, billing } = await verifiedTenant();
    await setLicenseTerms(subscription.id, terms(NOW + 2 * DAY), billing, NOW);
    const rec = buildRoutingRecord(await loadSubscription(prisma, subscription.id), NOW);
    expect(rec.license.phase).toBe('ACTIVE');
    expect(rec.license.nextPhaseChangeAt).toBe(NOW + 2 * DAY);
    expect(rec.license.schedule?.map((c) => c.phase)).toEqual(['GRACE', 'PANEL_BLOCKED', 'BLOCKED']);
    expect(rec.license.schedule?.map((c) => c.at)).toEqual([NOW + 2 * DAY, NOW + 9 * DAY, NOW + 24 * DAY]);
  });

  it('vencida hace 8 días: PANEL_BLOCKED, y el firmado llega al almacén', async () => {
    const { subscription, billing, operator, domain, store } = await verifiedTenant();
    await setLicenseTerms(subscription.id, terms(NOW - 8 * DAY), billing, NOW);
    await publishSubscription(subscription.id, operator, store, NOW);
    const raw = JSON.parse((await store.get(registryKeyForHost(domain.host)))!);
    const verified = await verifySnapshot(raw, { keys: { stest: await signerPublicKey() }, host: domain.host, now: NOW });
    expect(verified.ok && verified.body.record.license.phase).toBe('PANEL_BLOCKED');
  });

  it('«cambios sin publicar» no se enciende por el mero paso del tiempo, pero sí al cambiar los plazos', async () => {
    const { subscription, billing, operator, store } = await verifiedTenant();
    await setLicenseTerms(subscription.id, terms(NOW + 2 * DAY), billing, NOW);
    await publishSubscription(subscription.id, operator, store, NOW);
    const sub = await loadSubscription(prisma, subscription.id);
    expect(pendingChanges(sub, NOW)).toBe(false);
    expect(pendingChanges(sub, NOW + 5 * DAY)).toBe(false); // la fase cambió sola: no es un cambio a publicar
    await setLicenseTerms(subscription.id, terms(NOW + 2 * DAY, 10), billing, NOW);
    expect(pendingChanges(await loadSubscription(prisma, subscription.id), NOW)).toBe(true);
  });
});

describe('plazos y pagos', () => {
  it('solo facturación y superadmin los cambian; un operador no', async () => {
    const { subscription, billing, root, operator } = await verifiedTenant();
    await expect(setLicenseTerms(subscription.id, terms(NOW + DAY), operator, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(registerPayment(subscription.id, 30, operator, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await setLicenseTerms(subscription.id, terms(NOW + DAY), billing, NOW);
    await setLicenseTerms(subscription.id, terms(NOW + DAY), root, NOW);
  });

  it('valida los plazos y la fecha', async () => {
    const { subscription, billing } = await verifiedTenant();
    await expect(setLicenseTerms(subscription.id, terms(NOW, -1), billing, NOW)).rejects.toMatchObject({ code: 'invalid_license' });
    await expect(setLicenseTerms(subscription.id, terms(NOW, 7, 9999), billing, NOW)).rejects.toMatchObject({ code: 'invalid_license' });
    await expect(setLicenseTerms(subscription.id, terms(NOW, 7.5), billing, NOW)).rejects.toMatchObject({ code: 'invalid_license' });
    await expect(setLicenseTerms(subscription.id, terms(Date.UTC(1999, 0, 1)), billing, NOW)).rejects.toMatchObject({ code: 'invalid_license' });
    await expect(setLicenseTerms(subscription.id, terms(NOW + 50 * 365 * DAY), billing, NOW)).rejects.toMatchObject({ code: 'invalid_license' });
  });

  it('un pago alarga desde el fin de la cobertura (si sigue vigente) o desde hoy (si ya venció)', async () => {
    const { subscription, billing } = await verifiedTenant();
    await setLicenseTerms(subscription.id, terms(NOW + 10 * DAY), billing, NOW);
    expect((await registerPayment(subscription.id, 30, billing, NOW)).getTime()).toBe(NOW + 40 * DAY);
    await setLicenseTerms(subscription.id, terms(NOW - 20 * DAY), billing, NOW);
    expect((await registerPayment(subscription.id, 30, billing, NOW)).getTime()).toBe(NOW + 30 * DAY);
    expect(licenseStateOf(await loadSubscription(prisma, subscription.id), NOW).phase).toBe('ACTIVE');
  });

  it('una suscripción sin caducidad no se «activa» por un pago: hay que fijar una fecha primero', async () => {
    const { subscription, billing } = await verifiedTenant();
    await expect(registerPayment(subscription.id, 30, billing, NOW)).rejects.toMatchObject({ code: 'license_not_expiring' });
  });

  it('queda auditado con lo anterior y lo nuevo', async () => {
    const { subscription, billing } = await verifiedTenant();
    await setLicenseTerms(subscription.id, terms(NOW + DAY), billing, NOW);
    const row = await prisma.auditLog.findFirst({ where: { action: 'subscription.set_license', targetId: subscription.id } });
    expect(row?.meta).toMatchObject({ from: { paidThrough: null }, to: { graceDays: 7, panelBlockedDays: 15 } });
  });
});

describe('claves canjeables', () => {
  it('el código se muestra una vez y en la BD solo queda su huella', async () => {
    const { billing } = await verifiedTenant();
    const { code, id } = await createLicenseKey({ modules: ['contabilidad'], extendDays: 0 }, billing, NOW);
    expect(code).toMatch(/^LGR-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const row = await prisma.licenseKey.findUnique({ where: { id } });
    expect(JSON.stringify(row)).not.toContain(code.replace(/-/g, ''));
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'license_key.create', targetId: id } });
    expect(JSON.stringify(audit?.meta)).not.toContain(code.slice(4, 9));
  });

  it('canjearla activa los módulos (origen KEY) y alarga la vigencia', async () => {
    const { subscription, billing } = await verifiedTenant();
    await setLicenseTerms(subscription.id, terms(NOW + 5 * DAY), billing, NOW);
    const { code } = await createLicenseKey({ modules: ['contabilidad', 'wallets'], extendDays: 365 }, billing, NOW);
    const r = await redeemLicenseKey(subscription.id, code.toLowerCase().replace(/-/g, ' '), billing, NOW); // tolera minúsculas y separadores
    expect(r.added).toEqual(['contabilidad', 'wallets']);
    expect(r.paidThrough?.getTime()).toBe(NOW + 370 * DAY);
    const mods = await prisma.subscriptionModule.findMany({ where: { subscriptionId: subscription.id }, orderBy: { moduleKey: 'asc' } });
    expect(mods.find((m) => m.moduleKey === 'contabilidad')?.source).toBe('KEY');
    expect(mods.find((m) => m.moduleKey === 'tienda')?.source).toBe('MANUAL');
  });

  it('un solo uso: la segunda vez falla, y canjes simultáneos de la misma clave solo dejan ganar a uno', async () => {
    const { billing } = await verifiedTenant();
    const subs = await Promise.all(Array.from({ length: 8 }, () => rootCreateTenant(tenantInput())));
    const { code } = await createLicenseKey({ modules: ['sponsors'], extendDays: 0 }, billing, NOW);
    const results = await Promise.allSettled(subs.map((t) => redeemLicenseKey(t.subscription.id, code, billing, NOW)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'invalid_key' });
    expect(await prisma.subscriptionModule.count({ where: { moduleKey: 'sponsors' } })).toBe(1);
    // y una vez canjeada, ni siquiera de forma secuencial
    await expect(redeemLicenseKey(subs[0].subscription.id, code, billing, NOW)).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('inexistente, canjeada y caducada dan el MISMO error (no se confirma qué códigos existen)', async () => {
    const { subscription, billing } = await verifiedTenant();
    const used = await createLicenseKey({ modules: ['sponsors'], extendDays: 0 }, billing, NOW);
    await redeemLicenseKey(subscription.id, used.code, billing, NOW);
    const old = await createLicenseKey({ modules: ['contabilidad'], extendDays: 0, expiresInDays: 1 }, billing, NOW);
    const messages = await Promise.all(
      [used.code, 'LGR-AAAAA-BBBBB-CCCCC-DDDDD', old.code].map((c) =>
        redeemLicenseKey(subscription.id, c, billing, NOW + 3 * DAY).catch((e: Error) => e.message)
      )
    );
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toMatch(/no es válida/);
  });

  it('una clave que alarga vigencia no se consume sobre una suscripción sin caducidad', async () => {
    const { subscription, billing } = await verifiedTenant();
    const { code, id } = await createLicenseKey({ modules: [], extendDays: 30 }, billing, NOW);
    await expect(redeemLicenseKey(subscription.id, code, billing, NOW)).rejects.toMatchObject({ code: 'license_not_expiring' });
    expect((await prisma.licenseKey.findUnique({ where: { id } }))?.redeemedAt).toBeNull();
  });

  it('exige facturación; no activa módulos que el producto no tiene; no admite claves vacías', async () => {
    const { subscription, billing, operator } = await verifiedTenant();
    await expect(createLicenseKey({ modules: ['tienda'], extendDays: 0 }, operator, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createLicenseKey({ modules: ['holograma'], extendDays: 0 }, billing, NOW)).rejects.toMatchObject({ code: 'unknown_module' });
    await expect(createLicenseKey({ modules: [], extendDays: 0 }, billing, NOW)).rejects.toMatchObject({ code: 'invalid_license' });
    const { code } = await createLicenseKey({ modules: ['tienda'], extendDays: 0 }, billing, NOW);
    await expect(redeemLicenseKey(subscription.id, code, operator, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('revocación de emergencia', () => {
  it('escribe `revoked:{tenant}` en el registro, marca al cliente y audita; levantarla lo borra', async () => {
    const { tenant, operator, store } = await verifiedTenant();
    await emergencyRevoke(tenant.id, operator, store, NOW);
    expect(await store.get(registryKeyForRevocation(tenant.id))).toBe(String(NOW));
    expect((await prisma.tenant.findUnique({ where: { id: tenant.id } }))?.emergencyRevokedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'tenant.emergency_revoke', tenantId: tenant.id } })).toBe(1);

    await liftEmergencyRevocation(tenant.id, operator, store);
    expect(await store.get(registryKeyForRevocation(tenant.id))).toBeNull();
    expect((await prisma.tenant.findUnique({ where: { id: tenant.id } }))?.emergencyRevokedAt).toBeNull();
  });

  it('un VIEWER o facturación no puede revocar', async () => {
    const { tenant, billing, store } = await verifiedTenant();
    const { actor: viewer } = await makeOperator('VIEWER');
    await expect(emergencyRevoke(tenant.id, viewer, store, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(emergencyRevoke(tenant.id, billing, store, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('si el registro falla, no se marca al cliente como revocado y queda constancia del intento', async () => {
    const { tenant, operator } = await verifiedTenant();
    const broken: RegistryStore = { put: async () => { throw new Error('caído'); }, del: async () => {}, get: async () => null };
    await expect(emergencyRevoke(tenant.id, operator, broken, NOW)).rejects.toMatchObject({ code: 'registry_unavailable' });
    expect((await prisma.tenant.findUnique({ where: { id: tenant.id } }))?.emergencyRevokedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'tenant.emergency_revoke_failed', tenantId: tenant.id } })).toBe(1);
  });

  it('publicar de nuevo NO levanta la revocación', async () => {
    const { tenant, subscription, operator, store } = await verifiedTenant();
    await publishSubscription(subscription.id, operator, store, NOW);
    await emergencyRevoke(tenant.id, operator, store, NOW);
    await publishSubscription(subscription.id, operator, store, NOW + 1000);
    expect(await store.get(registryKeyForRevocation(tenant.id))).not.toBeNull();
  });
});

describe('refresco periódico de snapshots', () => {
  it('vuelve a publicar solo lo que ya estaba publicado y sube el seq', async () => {
    const { subscription, operator, store } = await verifiedTenant();
    const unpublished = await rootCreateTenant(tenantInput());
    await publishSubscription(subscription.id, operator, store, NOW);
    const r = await refreshAllSnapshots(operator, store, NOW + 6 * DAY);
    expect(r).toEqual({ published: 1, failed: [] });
    expect((await prisma.subscription.findUnique({ where: { id: subscription.id } }))?.snapshotSeq).toBe(2);
    expect((await prisma.subscription.findUnique({ where: { id: unpublished.subscription.id } }))?.snapshotSeq).toBe(0);
  });

  it('el refresco renueva `staleUntil` y avanza la fase publicada', async () => {
    const { subscription, billing, operator, domain, store } = await verifiedTenant();
    await setLicenseTerms(subscription.id, terms(NOW + 2 * DAY), billing, NOW);
    await publishSubscription(subscription.id, operator, store, NOW);
    await refreshAllSnapshots(operator, store, NOW + 6 * DAY);
    const raw = JSON.parse((await store.get(registryKeyForHost(domain.host)))!);
    const v = await verifySnapshot(raw, { keys: { stest: await signerPublicKey() }, host: domain.host, now: NOW + 6 * DAY });
    expect(v.ok && v.body.record.license.phase).toBe('GRACE');
    expect(v.ok && v.stale).toBe(false);
  });

  it('un fallo en una suscripción no impide el resto y se informa', async () => {
    const a = await verifiedTenant();
    const b = await verifiedTenant();
    await publishSubscription(a.subscription.id, a.operator, a.store, NOW);
    await publishSubscription(b.subscription.id, b.operator, a.store, NOW);
    // El registro rechaza las escrituras del dominio de B (y solo las suyas).
    const flaky: RegistryStore = {
      get: (k) => a.store.get(k),
      del: (k) => a.store.del(k),
      put: async (k, v) => {
        if (k === registryKeyForHost(b.domain.host)) throw new Error('registro rechaza la escritura');
        await a.store.put(k, v);
      },
    };
    const r = await refreshAllSnapshots(a.operator, flaky, NOW + DAY);
    expect(r.published).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].subscriptionId).toBe(b.subscription.id);
  });

  it('exige permiso de publicar', async () => {
    const { store } = await verifiedTenant();
    const { actor: viewer } = await makeOperator('VIEWER');
    await expect(refreshAllSnapshots(viewer, store, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('revisión de seguridad de M5 (panel)', () => {
  it('facturación puede publicar lo suyo: registrar un pago llega al registro sin depender de otro operador', async () => {
    const { subscription, billing, operator, tenant, domain, store } = await verifiedTenant();
    await setLicenseTerms(subscription.id, terms(NOW - 10 * DAY), billing, NOW);
    await publishSubscription(subscription.id, operator, store, NOW); // el cliente está en PANEL_BLOCKED
    await registerPayment(subscription.id, 60, billing, NOW);
    expect(await republishIfPublished(tenant.id, billing, store)).toEqual([]);
    const raw = JSON.parse((await store.get(registryKeyForHost(domain.host)))!);
    const v = await verifySnapshot(raw, { keys: { stest: await signerPublicKey() }, host: domain.host, now: Date.now() });
    expect(v.ok && v.body.record.license.phase).toBe('ACTIVE');
  });

  it('dos pagos simultáneos se suman los dos (sin pérdida de actualización)', async () => {
    const { subscription, billing } = await verifiedTenant();
    await setLicenseTerms(subscription.id, terms(NOW + 10 * DAY), billing, NOW);
    await Promise.all([registerPayment(subscription.id, 30, billing, NOW), registerPayment(subscription.id, 30, billing, NOW), registerPayment(subscription.id, 30, billing, NOW)]);
    expect((await prisma.subscription.findUnique({ where: { id: subscription.id } }))?.paidThrough?.getTime()).toBe(NOW + 100 * DAY);
  });

  it('la caducidad de una clave se valida (entero entre 1 y 730)', async () => {
    const { billing } = await verifiedTenant();
    for (const expiresInDays of [0.5, -3, 100000, Number.NaN]) {
      await expect(createLicenseKey({ modules: ['tienda'], extendDays: 0, expiresInDays }, billing, NOW)).rejects.toMatchObject({ code: 'invalid_license' });
    }
    await expect(createLicenseKey({ modules: ['tienda'], extendDays: 0, expiresInDays: 30 }, billing, NOW)).resolves.toBeTruthy();
  });

  it('el refresco omite las suscripciones sin ningún dominio verificado en vez de fallar siempre', async () => {
    const a = await verifiedTenant();
    await publishSubscription(a.subscription.id, a.operator, a.store, NOW);
    await prisma.domain.updateMany({ where: { subscriptionId: a.subscription.id }, data: { status: 'RELEASED' } });
    const b = await verifiedTenant();
    await publishSubscription(b.subscription.id, b.operator, b.store, NOW);
    const r = await refreshAllSnapshots(b.operator, b.store, NOW + DAY);
    expect(r).toEqual({ published: 1, failed: [] });
  });
});
