import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/permissions';
import {
  DOMAIN_COOLDOWN_DAYS,
  PENDING_CLAIM_DAYS,
  addDomain,
  releaseDomain,
  setPrimaryDomain,
  verificationRecordName,
  verificationRecordValue,
  verifyDomainDns,
  verifyDomainManually,
} from '@/lib/services/domains';
import { makeOperator, resetControlDb, tenantInput, uniq, rootCreateTenant } from './helpers';

beforeEach(resetControlDb);
const DAY = 86_400_000;

async function setup() {
  const { actor } = await makeOperator('OPERATOR');
  const { actor: root } = await makeOperator('SUPERADMIN');
  const t = await rootCreateTenant(tenantInput());
  return { actor, root, ...t };
}

describe('verificación de dominios', () => {
  it('verifica por DNS con el TXT correcto y el primero pasa a ser el principal', async () => {
    const { actor, domain } = await setup();
    const asked: string[] = [];
    const ok = await verifyDomainDns(domain.id, actor, async (name) => {
      asked.push(name);
      return [['otro'], [verificationRecordValue(domain.verificationToken)]];
    });
    expect(asked).toEqual([verificationRecordName(domain.host)]);
    expect(ok.status).toBe('VERIFIED');
    expect(ok.isPrimary).toBe(true);
  });

  it('el TXT puede venir partido en trozos (registros largos)', async () => {
    const { actor, domain } = await setup();
    const v = verificationRecordValue(domain.verificationToken);
    const res = await verifyDomainDns(domain.id, actor, async () => [[v.slice(0, 10), v.slice(10)]]);
    expect(res.status).toBe('VERIFIED');
  });

  it('rechaza si el TXT no está, es de otro dominio o el resolvedor falla', async () => {
    const { actor, domain } = await setup();
    await expect(verifyDomainDns(domain.id, actor, async () => [['grailla-verify=otro-token']])).rejects.toMatchObject({ code: 'dns_not_found' });
    await expect(verifyDomainDns(domain.id, actor, async () => { throw new Error('ENOTFOUND'); })).rejects.toMatchObject({ code: 'dns_not_found' });
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe('PENDING');
  });

  it('la verificación manual es solo de SUPERADMIN y queda auditada como manual', async () => {
    const { actor, root, domain, tenant } = await setup();
    await expect(verifyDomainManually(domain.id, actor)).rejects.toBeInstanceOf(ForbiddenError);
    await verifyDomainManually(domain.id, root);
    const entry = await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'domain.verify' } });
    expect(entry!.meta).toMatchObject({ how: 'manual' });
  });

  it('un VIEWER no puede añadir dominios', async () => {
    const { subscription } = await setup();
    const { actor: viewer } = await makeOperator('VIEWER');
    await expect(addDomain(subscription.id, 'nuevo.es', viewer)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('dominios: principal, liberación y lápidas', () => {
  it('cambia de principal solo entre verificados y no deja liberar el principal', async () => {
    const { actor, root, subscription, domain } = await setup();
    await verifyDomainManually(domain.id, root);
    const second = await addDomain(subscription.id, `otro-${uniq()}.es`, actor);
    await expect(setPrimaryDomain(second.id, actor)).rejects.toMatchObject({ code: 'domain_not_verified' });
    await verifyDomainManually(second.id, root);
    await expect(releaseDomain(domain.id, actor)).rejects.toMatchObject({ code: 'domain_is_primary' });
    await setPrimaryDomain(second.id, actor);
    await releaseDomain(domain.id, actor);
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe('RELEASED');
  });

  it('un dominio activo de otro cliente no se puede reclamar', async () => {
    const { actor, domain } = await setup();
    const other = await rootCreateTenant(tenantInput());
    await expect(addDomain(other.subscription.id, domain.host, actor)).rejects.toMatchObject({ code: 'domain_taken' });
  });

  it('el mismo dominio en la misma suscripción da error', async () => {
    const { actor, subscription, domain } = await setup();
    await expect(addDomain(subscription.id, domain.host, actor)).rejects.toMatchObject({ code: 'domain_exists' });
  });

  it('un dominio liberado queda reservado: el mismo cliente lo recupera, otro espera el periodo de reserva', async () => {
    const { actor, root, subscription, domain } = await setup();
    const keep = await addDomain(subscription.id, `keep-${uniq()}.es`, actor);
    await verifyDomainManually(keep.id, root);
    await verifyDomainManually(domain.id, root); // el principal pasa a ser el primero verificado
    await setPrimaryDomain(keep.id, actor);
    const t0 = Date.now();
    await releaseDomain(domain.id, actor, t0);

    const other = await rootCreateTenant(tenantInput());
    await expect(addDomain(other.subscription.id, domain.host, actor, t0 + 5 * DAY)).rejects.toMatchObject({ code: 'domain_reserved' });

    // El mismo cliente sí puede recuperarlo de inmediato, como PENDING y con un token nuevo.
    const back = await addDomain(subscription.id, domain.host, actor, t0 + DAY);
    expect(back.id).toBe(domain.id);
    expect(back.status).toBe('PENDING');
    expect(back.verificationToken).not.toBe(domain.verificationToken);

    // Pasado el periodo, otro cliente puede reclamarlo (tras liberarlo de nuevo).
    await verifyDomainManually(back.id, root);
    await releaseDomain(back.id, actor, t0 + DAY);
    const later = await addDomain(other.subscription.id, domain.host, actor, t0 + DAY + (DOMAIN_COOLDOWN_DAYS + 1) * DAY);
    expect(later.subscriptionId).toBe(other.subscription.id);
  });
});

describe('okupación de dominios sin verificar', () => {
  it('un dominio reclamado y nunca verificado bloquea al otro cliente solo %d días'.replace('%d', String(PENDING_CLAIM_DAYS)), async () => {
    const { actor, subscription, domain } = await setup();
    const other = await rootCreateTenant(tenantInput());
    const t0 = Date.now();
    // Dentro del plazo: bloquea. Pasado el plazo: lo puede reclamar su dueño real.
    await expect(addDomain(other.subscription.id, domain.host, actor, t0 + 2 * DAY)).rejects.toMatchObject({ code: 'domain_taken' });
    const taken = await addDomain(other.subscription.id, domain.host, actor, t0 + (PENDING_CLAIM_DAYS + 1) * DAY);
    expect(taken.subscriptionId).toBe(other.subscription.id);
    expect(subscription.id).not.toBe(other.subscription.id);
  });

  it('liberar un dominio que nunca se verificó no deja lápida', async () => {
    const { actor, subscription } = await setup();
    const extra = await addDomain(subscription.id, `extra-${uniq()}.es`, actor);
    await releaseDomain(extra.id, actor);
    const other = await rootCreateTenant(tenantInput());
    const claimed = await addDomain(other.subscription.id, extra.host, actor);
    expect(claimed.subscriptionId).toBe(other.subscription.id);
  });

  it('dos reclamaciones simultáneas del mismo dominio: solo gana una', async () => {
    const { actor } = await setup();
    const a = await rootCreateTenant(tenantInput());
    const b = await rootCreateTenant(tenantInput());
    const host = `disputado-${uniq()}.es`;
    const results = await Promise.allSettled([addDomain(a.subscription.id, host, actor), addDomain(b.subscription.id, host, actor)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.domain.count({ where: { host } })).toBe(1);
  });
});
