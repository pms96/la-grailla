import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/permissions';
import { ServiceError } from '@/lib/services/errors';
import { describeProvision, describeSeed } from '@/lib/services/lifecycle';
import { runMigrationsForSubscription } from '@/lib/services/migrations';
import type { ProvisionResult } from '@/lib/services/provision';
import { seedExistingTenant } from '@/lib/services/tenant-setup';
import { createTenant } from '@/lib/services/tenants';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';
import { createScratchDb, dropScratchDb, queryScratch } from './scratch-db';

const DB_RAW = 'lagrailla_scratch_setup_raw';
const DB_READY = 'lagrailla_scratch_setup_ready';
const LEGAL = { legal_notice: 'Aviso legal del cliente.', privacy_policy: 'Política de privacidad del cliente.', cookies_policy: 'Política de cookies del cliente.' };

let actor: Awaited<ReturnType<typeof makeOperator>>['actor'];
let rawSub = '';
let readySub = '';
let readyTenant = '';

beforeAll(async () => {
  await resetControlDb();
  freshStore();
  const urlRaw = await createScratchDb(DB_RAW);
  const urlReady = await createScratchDb(DB_READY);
  ({ actor } = await makeOperator('SUPERADMIN'));
  // Un cliente registrado y sin migrar, y otro registrado y migrado de verdad (con las migraciones reales del front), sin sembrar.
  rawSub = (await createTenant(tenantInput({ dbUrlPooled: urlRaw, dbUrlDirect: urlRaw }) as never, actor)).subscription.id;
  const ready = await createTenant(tenantInput({ dbUrlPooled: urlReady, dbUrlDirect: urlReady }) as never, actor);
  readySub = ready.subscription.id;
  readyTenant = ready.tenant.id;
  const migrated = await runMigrationsForSubscription(readySub, actor, { republish: false });
  expect(migrated.status).toBe('SUCCEEDED');
}, 180_000);
afterAll(async () => {
  await dropScratchDb(DB_RAW);
  await dropScratchDb(DB_READY);
}, 60_000);

describe('datos iniciales de un cliente ya registrado', () => {
  it('exige la BD migrada, un correo válido y permiso de superadmin', async () => {
    await expect(seedExistingTenant(rawSub, { adminEmail: 'a@cliente.test', legal: LEGAL }, actor)).rejects.toMatchObject({ code: 'migrate_first' });
    await expect(seedExistingTenant(readySub, { adminEmail: 'no-es-un-correo', legal: LEGAL }, actor)).rejects.toBeInstanceOf(ServiceError);
    const { actor: operator } = await makeOperator('OPERATOR');
    await expect(seedExistingTenant(readySub, { adminEmail: 'a@cliente.test', legal: LEGAL }, operator)).rejects.toBeInstanceOf(ForbiddenError);
    // Nada de lo anterior ha escrito nada.
    expect(await queryScratch(DB_READY, 'SELECT 1 FROM "User"')).toHaveLength(0);
  });

  it('siembra el email y los textos, crea el administrador con la contraseña mostrada (solo su hash en la BD) y dice qué falta', async () => {
    const r = await seedExistingTenant(readySub, { adminEmail: 'Dueno@Cliente.test', adminName: 'Dueño', legal: { privacy_policy: LEGAL.privacy_policy } }, actor);
    expect(r.adminEmail).toBe('dueno@cliente.test');
    expect(r.configWritten.sort()).toEqual(['admin_email', 'privacy_policy']);
    expect(r.missing.sort()).toEqual(['cookies_policy', 'legal_notice']);
    expect(r.adminPassword).toMatch(/^[A-Za-z0-9_-]{20}$/);

    const [admin] = await queryScratch<{ email: string; name: string; role: string; hashedPassword: string }>(DB_READY, 'SELECT email, name, role, "hashedPassword" FROM "User"');
    expect(admin).toMatchObject({ email: 'dueno@cliente.test', name: 'Dueño', role: 'ADMIN' });
    expect(await bcrypt.compare(r.adminPassword!, admin.hashedPassword)).toBe(true);
    const marker = await queryScratch<{ value: string }>(DB_READY, `SELECT value FROM "AppConfig" WHERE key = 'platform_tenant_id'`);
    expect(marker[0].value).toBe(readyTenant);
  });

  it('repetirlo con lo que faltaba lo completa sin crear otro administrador ni cambiar la contraseña', async () => {
    const r = await seedExistingTenant(readySub, { adminEmail: 'dueno@cliente.test', legal: LEGAL }, actor);
    expect(r.configWritten.sort()).toEqual(['cookies_policy', 'legal_notice']);
    expect(r.missing).toEqual([]);
    expect(r.adminPassword).toBeUndefined();
    expect(await queryScratch(DB_READY, 'SELECT 1 FROM "User"')).toHaveLength(1);

    // Y una tercera vez no cambia nada.
    const again = await seedExistingTenant(readySub, { adminEmail: 'dueno@cliente.test', legal: LEGAL }, actor);
    expect(again).toMatchObject({ configWritten: [], missing: [] });
  });

  it('deja constancia en la auditoría sin contraseña, textos ni correos', async () => {
    const rows = await prisma.auditLog.findMany({ where: { tenantId: readyTenant, action: 'tenant.seed' }, orderBy: { id: 'asc' } });
    expect(rows.length).toBe(3);
    expect(rows[0].meta).toMatchObject({ adminCreated: true, written: expect.arrayContaining(['admin_email']) });
    expect(rows[1].meta).toMatchObject({ adminCreated: false });
    const text = JSON.stringify(rows.map((r) => r.meta));
    expect(text).not.toMatch(/dueno@|Aviso legal|Política/);
  });
});

describe('cómo se cuenta el resultado', () => {
  const base: ProvisionResult = { ok: true, tenantId: 't1', subscriptionId: 's1', host: 'a.test', steps: [{ step: 'migrate', status: 'done', detail: '32 migraciones → 2026' }, { step: 'domain', status: 'done', detail: 'Verificado a mano' }, { step: 'publish', status: 'done', detail: 'versión 1' }], missing: [], published: true, adminPassword: 'Contr4señaTemporal' };

  it('alta correcta: pasos legibles, contraseña SOLO en «reveal» y enlace a la ficha', () => {
    const o = describeProvision(base, { adminEmail: 'dueno@cliente.test', extra: ['Crea este registro en el DNS del cliente: CNAME a.test → cname.vercel-dns.com'] });
    expect(o.ok).toBe('Cliente dado de alta y publicado.');
    expect(o.error).toBeUndefined();
    expect(o.details).toEqual(['✓ Migración: 32 migraciones → 2026', '✓ Dominio: Verificado a mano', '✓ Publicación: versión 1', 'Crea este registro en el DNS del cliente: CNAME a.test → cname.vercel-dns.com']);
    expect(o.reveal!.lines).toEqual(['Usuario: dueno@cliente.test', 'Contraseña temporal: Contr4señaTemporal']);
    expect(JSON.stringify({ ...o, reveal: undefined })).not.toContain('Contr4señaTemporal');
    expect(o.link).toEqual({ href: '/tenants/t1', label: 'Abrir la ficha del cliente' });
  });

  it('un paso fallido es un error y recuerda que se puede repetir; sin publicar y sin fallos no lo es', () => {
    const failed = describeProvision({ ...base, ok: false, published: false, adminPassword: undefined, steps: [{ step: 'migrate', status: 'failed', detail: 'P1001' }] }, { adminEmail: 'x@y.test' });
    expect(failed.error).toMatch(/repetir el alta/);
    expect(failed.ok).toBeUndefined();
    expect(failed.reveal).toBeUndefined();
    const pending = describeProvision({ ...base, ok: false, published: false, steps: [{ step: 'domain', status: 'blocked', detail: 'Pendiente de verificar' }] }, { adminEmail: 'x@y.test' });
    expect(pending.error).toBeUndefined();
    expect(pending.ok).toMatch(/sin publicar/);
    expect(pending.details![0]).toBe('✗ Dominio: Pendiente de verificar');
  });

  it('la siembra cuenta lo guardado, lo que falta, y enseña la contraseña una sola vez', () => {
    const o = describeSeed({ configWritten: ['admin_email'], adminEmail: 'a@b.test', adminPassword: 'Secreta123', missing: ['legal_notice'] });
    expect(o.ok).toMatch(/aún faltan/);
    expect(o.details).toEqual(['Guardado: admin_email', 'Siguen sin completar: legal_notice']);
    expect(o.reveal!.lines[1]).toContain('Secreta123');
    const done = describeSeed({ configWritten: [], adminEmail: 'a@b.test', missing: [] });
    expect(done.ok).toMatch(/Ya se puede salir a producción/);
    expect(done.details).toContain('El usuario administrador ya existía: su contraseña no se ha cambiado.');
    expect(done.reveal).toBeUndefined();
  });
});
