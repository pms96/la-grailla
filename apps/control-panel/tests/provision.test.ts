import bcrypt from 'bcryptjs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { registryKeyForHost, verifySnapshot } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/permissions';
import { listLocalMigrations, frontPrismaDir } from '@/lib/services/migrations';
import { goLiveTenant, localDatabaseName, provisionTenant, type ProvisionInput } from '@/lib/services/provision';
import { generateMasterKey } from '@grailla/contracts';
import { setRegistryStoreForTests } from '@/lib/registry/store';
import { freshStore, makeOperator, resetControlDb, signerPublicKey, uniq } from './helpers';
import { dropScratchDb, queryScratch, scratchDbExists } from './scratch-db';

const created: string[] = [];
const LEGAL = { legal_notice: 'Aviso legal del cliente.', privacy_policy: 'Política de privacidad del cliente.', cookies_policy: 'Política de cookies del cliente.' };

function input(over: Partial<ProvisionInput> = {}): ProvisionInput {
  const id = uniq();
  const dbName = `lagrailla_scratch_prov_${id}`.slice(0, 60);
  created.push(dbName);
  return {
    name: `Cliente ${id}`,
    primaryHost: `alta-${id}.localhost`,
    modules: ['tienda'],
    adminEmail: `dueno-${id}@cliente.test`,
    legal: LEGAL,
    database: { mode: 'local', name: dbName },
    domain: 'manual',
    ...over,
  };
}

beforeEach(async () => {
  await resetControlDb();
});
afterAll(async () => {
  for (const name of created) await dropScratchDb(name);
}, 60_000);

describe('alta de cliente de punta a punta', () => {
  it('crea BD, registra, migra, siembra, verifica y publica; y repetirla no cambia nada', async () => {
    const store = freshStore();
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input();
    const dbName = (inp.database as { name: string }).name;

    const first = await provisionTenant(inp, actor);
    expect(first.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      'database:done', 'register:done', 'migrate:done', 'seed:done', 'onboarding:done', 'domain:done', 'publish:done',
    ]);
    expect(first).toMatchObject({ ok: true, published: true, missing: [] });
    expect(first.adminPassword).toMatch(/^[A-Za-z0-9_-]{20}$/);

    // La BD del cliente: esquema real, configuración y un ADMIN con la contraseña mostrada (y solo su hash guardado).
    const local = listLocalMigrations(frontPrismaDir());
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: first.subscriptionId! } });
    expect(sub.schemaVersion).toBe(local[local.length - 1]);
    const cfg = await queryScratch<{ key: string; value: string }>(dbName, `SELECT key, value FROM "AppConfig" ORDER BY key`);
    expect(Object.fromEntries(cfg.map((c) => [c.key, c.value]))).toMatchObject({ admin_email: inp.adminEmail, ...LEGAL });
    const [admin] = await queryScratch<{ email: string; role: string; hashedPassword: string }>(dbName, `SELECT email, role, "hashedPassword" FROM "User"`);
    expect(admin).toMatchObject({ email: inp.adminEmail, role: 'ADMIN' });
    expect(await bcrypt.compare(first.adminPassword!, admin.hashedPassword)).toBe(true);

    // El registro firmado ya enruta el dominio con la versión de esquema.
    const raw = await store.get(registryKeyForHost(inp.primaryHost));
    const verified = await verifySnapshot(JSON.parse(raw!), { keys: { [process.env.SNAPSHOT_KID!]: await signerPublicKey() }, host: inp.primaryHost, now: Date.now() });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.body.record.schemaVersion).toBe(local[local.length - 1]);
    expect(verified.body.record.status).toBe('ACTIVE');

    // Idempotente: misma orden, mismo cliente, sin nueva contraseña ni nueva publicación.
    const second = await provisionTenant(inp, actor);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.adminPassword).toBeUndefined();
    expect(second.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      'database:skipped', 'register:skipped', 'migrate:skipped', 'seed:skipped', 'onboarding:done', 'domain:skipped', 'publish:skipped',
    ]);
    expect(await prisma.tenant.count()).toBe(1);
    expect(await queryScratch(dbName, `SELECT 1 FROM "User"`)).toHaveLength(1);
    const audit = await prisma.auditLog.findMany({ where: { tenantId: first.tenantId!, action: 'subscription.publish' } });
    expect(audit).toHaveLength(1);
  }, 180_000);

  it('sin textos legales o sin admin_email NO se da de alta (y no se crea nada)', async () => {
    freshStore();
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input({ legal: { legal_notice: 'solo esto' } });
    await expect(provisionTenant(inp, actor)).rejects.toThrow(/privacy_policy, cookies_policy/);
    expect(await prisma.tenant.count()).toBe(0);
    expect(await scratchDbExists((inp.database as { name: string }).name)).toBe(false);
    await expect(provisionTenant(input({ adminEmail: 'no-es-un-correo' }), actor)).rejects.toThrow(/correo válido/);
  });

  it('con allowIncomplete se da de alta pero NO se verifica ni se publica; completar los datos y repetir lo publica', async () => {
    const store = freshStore();
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input({ legal: {}, allowIncomplete: true });

    const first = await provisionTenant(inp, actor);
    expect(first).toMatchObject({ ok: false, published: false });
    expect(first.missing).toEqual(['legal_notice', 'privacy_policy', 'cookies_policy']);
    expect(first.steps.find((s) => s.step === 'domain')).toMatchObject({ status: 'blocked' });
    expect(first.dnsRecord?.name).toBe(`_grailla-verify.${inp.primaryHost}`);
    expect(await store.get(registryKeyForHost(inp.primaryHost))).toBeNull();

    // El cliente (o el operador) completa lo que faltaba y se repite la MISMA orden.
    const second = await provisionTenant({ ...inp, legal: LEGAL, allowIncomplete: false }, actor);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second).toMatchObject({ ok: true, published: true, missing: [] });
    expect(second.adminPassword).toBeUndefined(); // el usuario ya se creó en la primera pasada
    expect(await prisma.tenant.count()).toBe(1);
    expect(await store.get(registryKeyForHost(inp.primaryHost))).not.toBeNull();
  }, 180_000);

  it('un fallo de migración se queda en ese paso y repetir continúa (sin segundo cliente)', async () => {
    freshStore();
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input();
    const bad = await provisionTenant(inp, actor, { migrate: { prismaDir: (await import('./scratch-db')).makeFixturePrismaDir({ '20270101000000_rota': 'ALTER TABLE "no_existe" ADD COLUMN "x" TEXT;' }) } });
    expect(bad.ok).toBe(false);
    expect(bad.steps.at(-1)).toMatchObject({ step: 'migrate', status: 'failed' });
    expect(bad.published).toBe(false);
    expect(await prisma.tenant.count()).toBe(1);
  }, 120_000);

  it('el dominio de otro cliente no se puede reclamar y no se siembran credenciales', async () => {
    freshStore();
    const { actor } = await makeOperator('SUPERADMIN');
    const a = input();
    await provisionTenant(a, actor);
    await expect(provisionTenant({ ...input(), primaryHost: a.primaryHost }, actor)).rejects.toThrow(/ya pertenece a otro cliente/);
    await expect(provisionTenant(input({ config: { stripe_secret_key: 'sk_live_x' } }), actor)).resolves.toMatchObject({ ok: false });
  }, 240_000);

  it('exige permisos de SUPERADMIN (crear un cliente fija a qué BD apunta)', async () => {
    const { actor } = await makeOperator('OPERATOR');
    await expect(provisionTenant(input(), actor)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('el nombre de BD local sale del nombre del cliente y solo admite caracteres seguros', () => {
    expect(localDatabaseName('Cliente Ñandú, S.L.')).toBe('lagrailla_cliente_and_s_l');
  });

  it('«salir a producción» después: el cliente completa sus textos en SU BD y goLive verifica y publica', async () => {
    const store = freshStore();
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input({ legal: {}, allowIncomplete: true });
    const first = await provisionTenant(inp, actor);
    expect(first.published).toBe(false);

    const still = await goLiveTenant(first.subscriptionId!, { domain: 'manual' }, actor);
    expect(still).toMatchObject({ ok: false, published: false });
    expect(still.missing).toContain('privacy_policy');

    const dbName = (inp.database as { name: string }).name;
    for (const key of ['legal_notice', 'privacy_policy', 'cookies_policy']) {
      await queryScratch(dbName, `INSERT INTO "AppConfig" (id, key, value) VALUES ('cx_${key}', '${key}', 'texto del cliente') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    }
    const rows = await queryScratch<{ key: string }>(dbName, `SELECT key FROM "AppConfig" WHERE key IN ('legal_notice','privacy_policy','cookies_policy') AND value = 'texto del cliente'`);
    expect(rows).toHaveLength(3);

    const live = await goLiveTenant(first.subscriptionId!, { domain: 'manual' }, actor);
    expect(live).toMatchObject({ ok: true, published: true, missing: [] });
    expect(await store.get(registryKeyForHost(inp.primaryHost))).not.toBeNull();
  }, 180_000);

  it('con checkHealth sondea el front con el secreto del cliente y deja el resultado guardado', async () => {
    freshStore();
    process.env.PLATFORM_CRON_MASTER = generateMasterKey();
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input();
    const calls: string[] = [];
    const res = await provisionTenant(inp, actor, {
      checkHealth: true,
      healthFetch: async (url, init) => {
        calls.push(`${url} ${(init?.headers as Record<string, string>).Authorization.slice(0, 7)}`);
        const sub = await prisma.subscription.findFirstOrThrow({ where: { domains: { some: { host: inp.primaryHost } } } });
        return new Response(
          JSON.stringify({
            status: 'ok', version: 'dev', platform: true, tenantId: sub.tenantId, db: { ok: true, latencyMs: 2 },
            schema: { applied: sub.schemaVersion, expected: sub.schemaVersion, minRequired: sub.schemaVersion, upToDate: true },
            onboarding: { complete: true, missing: [] },
          }),
          { status: 200 }
        );
      },
    });
    expect(res.ok).toBe(true);
    expect(res.steps.at(-1)).toMatchObject({ step: 'health', status: 'done' });
    expect(calls[0]).toMatch(/\/api\/health Bearer /);
    expect((await prisma.tenantHealth.findUniqueOrThrow({ where: { subscriptionId: res.subscriptionId! } })).ok).toBe(true);
  }, 120_000);

  it('la contraseña inicial se entrega EN CUANTO se crea, aunque un paso posterior falle (registro caído)', async () => {
    freshStore();
    setRegistryStoreForTests({ put: async () => { throw new Error('registro caído postgresql://u:p@x/y'); }, get: async () => null, del: async () => {} } as never);
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input();
    const given: string[] = [];
    const res = await provisionTenant(inp, actor, { onCredentials: (p) => void given.push(p) });
    expect(given).toHaveLength(1);
    expect(given[0]).toBe(res.adminPassword);
    expect(res.ok).toBe(false);
    expect(res.steps.at(-1)).toMatchObject({ step: 'finish', status: 'failed' });
    // Ninguna cadena de conexión llega al informe, ni siquiera dentro de un mensaje de error de otro componente.
    expect(JSON.stringify(res.steps)).not.toContain('u:p@x');
    expect(JSON.stringify(res.steps)).toContain('[oculto]');

    // Repetir (con el registro ya sano) termina, y NO vuelve a crear ni a mostrar otra contraseña.
    freshStore();
    const again = await provisionTenant(inp, actor, { onCredentials: (p) => void given.push(p) });
    expect(again).toMatchObject({ ok: true, published: true });
    expect(given).toHaveLength(1);
  }, 120_000);

  it('repetir el alta con OTRA URL de BD falla en voz alta en vez de migrar y sembrar la antigua', async () => {
    freshStore();
    const { actor } = await makeOperator('SUPERADMIN');
    const inp = input();
    await provisionTenant(inp, actor);
    const other = { ...inp, database: { mode: 'existing' as const, pooledUrl: 'postgresql://x:y@localhost:5432/otra', directUrl: 'postgresql://x:y@localhost:5432/otra' } };
    await expect(provisionTenant(other, actor)).rejects.toThrow(/otra URL de BD/);
    expect(await prisma.tenant.count()).toBe(1);
  }, 120_000);

  it('una BD ya migrada dada de alta sin versión de esquema queda con la versión correcta (no en mantenimiento)', async () => {
    freshStore();
    const { actor } = await makeOperator('SUPERADMIN');
    const first = input();
    await provisionTenant(first, actor, {}); // deja la BD local creada y migrada
    // Mismo servidor, BD ya migrada, cliente NUEVO con --database-existing y sin schemaVersion:
    const url = (await import('./scratch-db')).scratchUrl((first.database as { name: string }).name);
    const second = input({ database: { mode: 'existing', pooledUrl: url, directUrl: url } });
    const res = await provisionTenant(second, actor);
    expect(res.steps.find((s) => s.step === 'migrate')).toMatchObject({ status: 'skipped' });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: res.subscriptionId! } });
    const local = listLocalMigrations(frontPrismaDir());
    expect(sub.schemaVersion).toBe(local[local.length - 1]);
    expect(res.published).toBe(true);
  }, 120_000);
});
