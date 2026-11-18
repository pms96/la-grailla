import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenError, can } from '@/lib/permissions';
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
    const second = await addDomain(subscription.id, `otro-${uniq()}.es`, root);
    await expect(setPrimaryDomain(second.id, root)).rejects.toMatchObject({ code: 'domain_not_verified' });
    await verifyDomainManually(second.id, root);
    await expect(releaseDomain(domain.id, actor)).rejects.toMatchObject({ code: 'domain_is_primary' });
    await setPrimaryDomain(second.id, root);
    await releaseDomain(domain.id, actor);
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe('RELEASED');
  });

  it('un dominio activo de otro cliente no se puede reclamar', async () => {
    const { root, domain } = await setup();
    const other = await rootCreateTenant(tenantInput());
    await expect(addDomain(other.subscription.id, domain.host, root)).rejects.toMatchObject({ code: 'domain_taken' });
  });

  it('el mismo dominio en la misma suscripción da error', async () => {
    const { root, subscription, domain } = await setup();
    await expect(addDomain(subscription.id, domain.host, root)).rejects.toMatchObject({ code: 'domain_exists' });
  });

  it('un dominio liberado queda reservado: el mismo cliente lo recupera, otro espera el periodo de reserva', async () => {
    const { actor, root, subscription, domain } = await setup();
    const keep = await addDomain(subscription.id, `keep-${uniq()}.es`, root);
    await verifyDomainManually(keep.id, root);
    await verifyDomainManually(domain.id, root); // el principal pasa a ser el primero verificado
    await setPrimaryDomain(keep.id, root);
    const t0 = Date.now();
    await releaseDomain(domain.id, actor, t0);

    const other = await rootCreateTenant(tenantInput());
    await expect(addDomain(other.subscription.id, domain.host, root, t0 + 5 * DAY)).rejects.toMatchObject({ code: 'domain_reserved' });

    // El mismo cliente sí puede recuperarlo de inmediato, como PENDING y con un token nuevo.
    const back = await addDomain(subscription.id, domain.host, root, t0 + DAY);
    expect(back.id).toBe(domain.id);
    expect(back.status).toBe('PENDING');
    expect(back.verificationToken).not.toBe(domain.verificationToken);

    // Pasado el periodo, otro cliente puede reclamarlo (tras liberarlo de nuevo).
    await verifyDomainManually(back.id, root);
    await releaseDomain(back.id, actor, t0 + DAY);
    const later = await addDomain(other.subscription.id, domain.host, root, t0 + DAY + (DOMAIN_COOLDOWN_DAYS + 1) * DAY);
    expect(later.subscriptionId).toBe(other.subscription.id);
  });
});

describe('okupación de dominios sin verificar', () => {
  it('un dominio reclamado y nunca verificado bloquea al otro cliente solo %d días'.replace('%d', String(PENDING_CLAIM_DAYS)), async () => {
    const { root, subscription, domain } = await setup();
    const other = await rootCreateTenant(tenantInput());
    const t0 = Date.now();
    // Dentro del plazo: bloquea. Pasado el plazo: lo puede reclamar su dueño real.
    await expect(addDomain(other.subscription.id, domain.host, root, t0 + 2 * DAY)).rejects.toMatchObject({ code: 'domain_taken' });
    const taken = await addDomain(other.subscription.id, domain.host, root, t0 + (PENDING_CLAIM_DAYS + 1) * DAY);
    expect(taken.subscriptionId).toBe(other.subscription.id);
    expect(subscription.id).not.toBe(other.subscription.id);
  });

  it('liberar un dominio que nunca se verificó no deja lápida', async () => {
    const { actor, root, subscription } = await setup();
    const extra = await addDomain(subscription.id, `extra-${uniq()}.es`, root);
    await releaseDomain(extra.id, actor);
    const other = await rootCreateTenant(tenantInput());
    const claimed = await addDomain(other.subscription.id, extra.host, root);
    expect(claimed.subscriptionId).toBe(other.subscription.id);
  });

  it('dos reclamaciones simultáneas del mismo dominio: solo gana una', async () => {
    const { root } = await setup();
    const a = await rootCreateTenant(tenantInput());
    const b = await rootCreateTenant(tenantInput());
    const host = `disputado-${uniq()}.es`;
    const results = await Promise.allSettled([addDomain(a.subscription.id, host, root), addDomain(b.subscription.id, host, root)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.domain.count({ where: { host } })).toBe(1);
  });
});

/* H-234: añadir un dominio y marcarlo principal cambia a dónde apuntan los enlaces de email y los retornos de pago de un cliente. La verificación por DNS prueba que se controla el dominio, no que sea del
 * cliente: con `tenants:write` (OPERATOR) un operador malintencionado podía encadenar alta, verificación y «principal». Ahora el alta y el principal son de SUPERADMIN. */
describe('H-234: alta de dominio y dominio principal reservados a SUPERADMIN', () => {
  it('un OPERATOR no puede añadir un dominio, ni marcarlo principal; un SUPERADMIN sí', async () => {
    const { actor, root, subscription, domain } = await setup();
    await verifyDomainManually(domain.id, root);
    await expect(addDomain(subscription.id, `intruso-${uniq()}.es`, actor)).rejects.toBeInstanceOf(ForbiddenError);
    const second = await addDomain(subscription.id, `legitimo-${uniq()}.es`, root);
    await verifyDomainManually(second.id, root);
    await expect(setPrimaryDomain(second.id, actor)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: second.id } })).isPrimary).toBe(false);
    await setPrimaryDomain(second.id, root);
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: second.id } })).isPrimary).toBe(true);
  });

  it('el OPERATOR conserva lo que no cambia a dónde apunta el cliente: verificar por DNS y liberar un dominio que no es el principal', async () => {
    const { actor, root, subscription, domain } = await setup();
    await verifyDomainManually(domain.id, root);
    const second = await addDomain(subscription.id, `extra-${uniq()}.es`, root);
    const verified = await verifyDomainDns(second.id, actor, async () => [[verificationRecordValue(second.verificationToken)]]);
    expect(verified.status).toBe('VERIFIED');
    await releaseDomain(second.id, actor);
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('RELEASED');
  });

  it('la matriz: solo SUPERADMIN tiene `domains:manage`', () => {
    expect(can('SUPERADMIN', 'domains:manage')).toBe(true);
    for (const role of ['OPERATOR', 'BILLING', 'VIEWER'] as const) expect(can(role, 'domains:manage')).toBe(false);
  });

  it('la ficha del cliente enseña «Añadir dominio» y «Hacer principal» solo con `domains:manage` (invariante de código)', () => {
    const page = readFileSync(join(process.cwd(), 'app/tenants/[id]/page.tsx'), 'utf8');
    expect(page).toMatch(/can\(role, 'domains:manage'\)/);
    expect(page).not.toMatch(/canWrite\s*&&\s*d\.status === 'VERIFIED'\s*&&\s*!d\.isPrimary/); // «Hacer principal» ya no cuelga de canWrite
    const addForm = page.slice(page.indexOf('addDomainAction.bind') - 200, page.indexOf('addDomainAction.bind'));
    expect(addForm).not.toMatch(/\{canWrite &&/); // el formulario de alta ya no depende solo de canWrite
  });

  it('las acciones del panel exigen `domains:manage` para el alta y el principal (invariante de código)', () => {
    const actions = readFileSync(join(process.cwd(), 'app/actions/tenants.ts'), 'utf8');
    expect(actions).toMatch(/export async function addDomainAction[\s\S]{0,200}run\('domains:manage'/);
    expect(actions).toMatch(/export async function setPrimaryAction[\s\S]{0,200}run\('domains:manage'/);
  });
});
