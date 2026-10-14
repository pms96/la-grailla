import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { missingOnboarding, ONBOARDING_REQUIRED_CONFIG } from '@grailla/contracts';
import type { ActingOperator } from '../actor';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import { openField } from '../secrets-store';
import { verifyDomainDns, verifyDomainManually, parseHostOrThrow, verificationRecordName, verificationRecordValue } from './domains';
import { ServiceError } from './errors';
import { probeTenantHealth, recordHealth, type ProbeResult } from './health';
import type { FetchLike } from './tenant-calls';
import { redactUrls } from '../migrations/executor';
import { runMigrationsForSubscription, type MigrationRunResult, type RunOptions } from './migrations';
import { loadSubscription, pendingChanges, publishSubscription } from './snapshot';
import { assertProvisionTarget, withTenantDb, writeTenantMarker } from './tenant-db';
import { createTenant, DB_URL_DIRECT_FIELD } from './tenants';

/* Alta de un cliente de punta a punta (M7), por script y SIN tocar código. Cada paso es idempotente: si se corta a medias, repetir el
 * mismo comando continúa donde se quedó (no crea un segundo cliente, no rehace la BD, no cambia una contraseña ya creada).
 *
 *   validar → BD → registrar → migrar → sembrar → comprobar datos mínimos → dominio → publicar → comprobar salud
 *
 * La saga reanudable con estado propio (`ProvisioningRun`) llega con el umbral de 3 a 5 clientes; hasta entonces basta con repetir.
 *
 * Datos mínimos para PUBLICAR (obligatorios): `admin_email` y los tres textos legales. Sin ellos el cliente se da de alta pero NO se
 * verifica el dominio ni se publica (la web no existe para el público) — salvo que se pida explícitamente (`allowIncomplete`) y aun así
 * no se publica. */

export type StepStatus = 'done' | 'skipped' | 'blocked' | 'failed';
export type StepResult = { step: string; status: StepStatus; detail?: string };

export type ProvisionInput = {
  name: string;
  productKey?: string;
  primaryHost: string;
  modules: string[];
  /** Destinatario de los avisos del cliente (obligatorio). */
  adminEmail: string;
  /** Primer usuario ADMIN de la web del cliente; si no se da, se usa `adminEmail`. */
  adminUser?: { email?: string; name?: string };
  legal: { legal_notice?: string; privacy_policy?: string; cookies_policy?: string };
  /** Más claves de AppConfig (no secretas) con las que sembrar la BD, p. ej. redes sociales. Solo se escriben si no existen. */
  config?: Record<string, string>;
  database: { mode: 'existing'; pooledUrl: string; directUrl: string } | { mode: 'local'; name: string };
  /** `dns`: comprueba el TXT; `manual`: lo da por verificado (SUPERADMIN, p. ej. desarrollo); `pending`: lo deja pendiente. */
  domain?: 'dns' | 'manual' | 'pending';
  publish?: boolean;
  /** Seguir aunque falten datos mínimos: el cliente queda SIN publicar. */
  allowIncomplete?: boolean;
  schemaVersion?: string | null;
  dbRegion?: string | null;
  /**
   * Adoptar una BD que YA tiene datos y no está marcada como de ningún cliente (p. ej. un cliente anterior a la plataforma). Sin esto, un alta
   * se niega en una BD con datos: con una URL equivocada acabaría sembrando un administrador conocido en la BD de producción de otro cliente.
   * Al adoptar no se crea ningún administrador si la BD ya tiene usuarios.
   */
  adoptDatabase?: boolean;
};

export type ProvisionDeps = {
  migrate?: RunOptions;
  healthFetch?: FetchLike;
  /** Se invoca EN CUANTO se crea el usuario administrador, antes de los pasos que pueden fallar: la contraseña no se puede recuperar después. */
  onCredentials?: (password: string) => void | Promise<void>;
  /** Comprobar la salud tras publicar (necesita PLATFORM_CRON_MASTER y que el front sea alcanzable). */
  checkHealth?: boolean;
  now?: () => number;
};

export type ProvisionResult = {
  ok: boolean;
  tenantId: string | null;
  subscriptionId: string | null;
  host: string;
  steps: StepResult[];
  /** Solo la primera vez que se crea el usuario; no se vuelve a poder ver. */
  adminPassword?: string;
  /** Registro DNS pendiente de crear por el cliente (si el dominio sigue sin verificar). */
  dnsRecord?: { name: string; value: string };
  missing: string[];
  published: boolean;
  health?: ProbeResult;
};

const SECRETISH_KEY = /(pass(word)?|secret|token|key|smtp_user|cert|service_account)/i;
const CONFIG_GROUPS: Record<string, string> = { legal_notice: 'legal', privacy_policy: 'legal', cookies_policy: 'legal', admin_email: 'general' };
const LABELS: Record<string, string> = {
  legal_notice: 'Aviso Legal',
  privacy_policy: 'Política de Privacidad',
  cookies_policy: 'Política de Cookies',
  admin_email: 'Email de administración',
};

const cuidLike = () => `c${crypto.randomBytes(12).toString('hex')}`;
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

function isLocalHost(hostname: string) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

/** Servidor desde el que se crean BDs locales: el mismo Postgres que la BD de control (solo local; en producción cada cliente trae su BD). */
function localAdminUrl(): URL {
  const u = new URL(process.env.CONTROL_DIRECT_URL || process.env.CONTROL_DATABASE_URL || '');
  if (!isLocalHost(u.hostname)) throw new ServiceError('local_only', 'Crear la BD desde aquí solo está permitido en un Postgres local; en producción usa --database-existing con la BD ya creada');
  u.pathname = '/postgres';
  u.search = '';
  return u;
}

export const localDatabaseName = (slug: string) => `lagrailla_${slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)}`;

async function ensureLocalDatabase(name: string): Promise<{ url: string; created: boolean }> {
  if (!/^lagrailla_[a-z0-9_]{1,50}$/.test(name)) throw new ServiceError('invalid_database_name', 'El nombre de BD local debe ser lagrailla_<letras, números y _>');
  const admin = localAdminUrl();
  const db = new PrismaClient({ datasourceUrl: admin.toString(), log: [] });
  try {
    const exists = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT 1 AS n FROM pg_database WHERE datname = '${name}'`);
    if (!exists.length) await db.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(admin.toString());
    url.pathname = `/${name}`;
    return { url: url.toString(), created: !exists.length };
  } finally {
    await db.$disconnect();
  }
}

/**
 * Marca la BD como de este cliente, siembra la configuración (sin pisar lo que ya exista) y el primer ADMIN. Devuelve la contraseña solo si
 * el usuario es nuevo. La marca va PRIMERO: así una BD en la que se llegó a sembrar algo siempre dice de quién es.
 */
export async function seedTenantDb(
  url: string,
  args: { tenantId: string; config: Record<string, string>; adminEmail: string; adminName: string; createAdmin: boolean }
): Promise<{ configWritten: string[]; adminPassword?: string }> {
  const marker = await writeTenantMarker(url, args.tenantId, cuidLike);
  if (marker !== args.tenantId) throw new ServiceError('database_belongs_to_other_tenant', `Esa base de datos pertenece a otro cliente (${marker}): no se siembra nada`);
  return withTenantDb(url, async (db) => {
    const written: string[] = [];
    for (const [key, value] of Object.entries(args.config)) {
      if (SECRETISH_KEY.test(key)) throw new ServiceError('secret_config_key', `No se siembran credenciales (${key}): las introduce el cliente desde su panel`);
      const rows = await db.$executeRawUnsafe(
        `INSERT INTO "AppConfig" ("id", "key", "value", "label", "group") VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("key") DO NOTHING`,
        cuidLike(),
        key,
        value,
        LABELS[key] ?? key,
        CONFIG_GROUPS[key] ?? 'general'
      );
      if (rows > 0) written.push(key);
    }
    // Una clave ya sembrada pero VACÍA (p. ej. por un alta anterior incompleta) se rellena: «no pisar» es solo para lo que tiene valor.
    for (const [key, value] of Object.entries(args.config)) {
      if (written.includes(key) || !value.trim()) continue;
      const rows = await db.$executeRawUnsafe(`UPDATE "AppConfig" SET "value" = $2 WHERE "key" = $1 AND btrim("value") = ''`, key, value);
      if (rows > 0) written.push(key);
    }
    if (!args.createAdmin) return { configWritten: written };
    const existing = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "User" WHERE "email" = $1`, args.adminEmail);
    if (existing.length) return { configWritten: written };
    const password = crypto.randomBytes(15).toString('base64url');
    const hashed = await bcrypt.hash(password, 12);
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "name", "hashedPassword", "role", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, 'ADMIN', now(), now()) ON CONFLICT ("email") DO NOTHING`,
      cuidLike(),
      args.adminEmail,
      args.adminName,
      hashed
    );
    return { configWritten: written, adminPassword: password };
  });
}

/** Lee de la BD del cliente lo mínimo obligatorio (para decidir si se puede publicar). */
export async function readOnboarding(url: string): Promise<string[]> {
  return withTenantDb(url, async (db) => {
    const rows = await db.$queryRawUnsafe<{ key: string; value: string }[]>(`SELECT "key", "value" FROM "AppConfig" WHERE "key" = ANY($1::text[])`, [...ONBOARDING_REQUIRED_CONFIG]);
    return missingOnboarding(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  });
}

type GoLiveArgs = {
  subscriptionId: string;
  tenantId: string;
  host: string;
  dbUrl: string;
  actor: ActingOperator;
  domainMode: 'dns' | 'manual' | 'pending';
  publish: boolean;
  deps: ProvisionDeps;
  step: (s: StepResult) => void;
  result: ProvisionResult;
};

/** Pasos finales del alta: comprobar datos mínimos, verificar el dominio, publicar y mirar la salud. Se reutiliza para «salir a producción» más tarde. */
async function goLiveSteps(args: GoLiveArgs): Promise<void> {
  // 6. ¿Se puede publicar? (se lee de la BD real, no de lo que dijo el operador: así también vale para repetir un alta incompleta).
  args.result.missing = await readOnboarding(args.dbUrl);
  args.step({ step: 'onboarding', status: args.result.missing.length ? 'blocked' : 'done', detail: args.result.missing.length ? `Faltan: ${args.result.missing.join(', ')}` : 'Datos mínimos completos' });

  // 7. Dominio.
  let domain = await prisma.domain.findUniqueOrThrow({ where: { host: args.host } });
  const mode = args.domainMode;
  if (domain.status !== 'VERIFIED') {
    if (args.result.missing.length) {
      args.step({ step: 'domain', status: 'blocked', detail: 'No se verifica mientras falten datos obligatorios' });
    } else if (mode === 'manual') {
      domain = await verifyDomainManually(domain.id, args.actor, args.deps.now?.());
      args.step({ step: 'domain', status: 'done', detail: 'Verificado a mano' });
    } else if (mode === 'dns') {
      try {
        domain = await verifyDomainDns(domain.id, args.actor, undefined, args.deps.now?.());
        args.step({ step: 'domain', status: 'done', detail: 'Verificado por DNS' });
      } catch (err) {
        args.step({ step: 'domain', status: 'blocked', detail: err instanceof ServiceError ? err.message : 'DNS sin comprobar' });
      }
    } else {
      args.step({ step: 'domain', status: 'blocked', detail: 'Pendiente de verificar' });
    }
  } else {
    args.step({ step: 'domain', status: 'skipped', detail: 'Ya estaba verificado' });
  }
  if (domain.status !== 'VERIFIED') {
    args.result.dnsRecord = { name: verificationRecordName(args.host), value: verificationRecordValue(domain.verificationToken) };
  }

  // 8. Publicar.
  if (domain.status === 'VERIFIED' && !args.result.missing.length && args.publish) {
    // Repetir un alta ya terminada no debe republicar (cada publicación sube el seq y lo auditan).
    const current = await loadSubscription(prisma, args.subscriptionId);
    if (current.lastPublishedAt && !pendingChanges(current, args.deps.now?.())) {
      args.result.published = true;
      args.step({ step: 'publish', status: 'skipped', detail: 'Ya estaba publicado y sin cambios' });
    } else {
      const pub = await publishSubscription(args.subscriptionId, args.actor, undefined, args.deps.now?.());
      args.result.published = true;
      args.step({ step: 'publish', status: 'done', detail: `versión ${pub.seq} en ${pub.hosts.join(', ')}` });
    }
  } else {
    args.step({ step: 'publish', status: 'blocked', detail: 'No se publica todavía' });
  }

  // 9. Salud (opcional): el front real responde con el contexto del cliente.
  if (args.result.published && args.deps.checkHealth) {
    const fresh = await prisma.subscription.findUniqueOrThrow({ where: { id: args.subscriptionId } });
    const probe = await probeTenantHealth({ tenantId: args.tenantId, host: args.host, declaredSchema: fresh.schemaVersion }, { fetchImpl: args.deps.healthFetch });
    await recordHealth(args.subscriptionId, probe);
    args.result.health = probe;
    args.step({ step: 'health', status: probe.reachable && probe.problems.length === 0 ? 'done' : 'failed', detail: probe.problems.join(' · ') || 'Todo responde' });
  }
}

export async function provisionTenant(input: ProvisionInput, actor: ActingOperator, deps: ProvisionDeps = {}): Promise<ProvisionResult> {
  assertCan(actor.role, 'tenants:write');
  assertCan(actor.role, 'database:write');
  assertCan(actor.role, 'migrations:run');

  // 1. Validar ANTES de tocar nada: un alta rechazada no deja BDs ni clientes a medias.
  const name = input.name.trim();
  const host = parseHostOrThrow(input.primaryHost);
  const adminEmail = input.adminEmail.trim();
  if (!isEmail(adminEmail)) throw new ServiceError('invalid_admin_email', 'adminEmail debe ser un correo válido');
  const adminUserEmail = (input.adminUser?.email ?? adminEmail).trim().toLowerCase();
  if (!isEmail(adminUserEmail)) throw new ServiceError('invalid_admin_user', 'El correo del usuario administrador no es válido');
  const config: Record<string, string> = { ...(input.config ?? {}), admin_email: adminEmail, ...Object.fromEntries(Object.entries(input.legal).filter(([, v]) => (v ?? '').trim())) } as Record<string, string>;
  const missingBefore = missingOnboarding(config);
  if (missingBefore.length && !input.allowIncomplete) {
    throw new ServiceError('onboarding_incomplete', `Faltan datos obligatorios para publicar: ${missingBefore.join(', ')} (o pasa allowIncomplete para dar de alta sin publicar)`);
  }

  const steps: StepResult[] = [];
  const result: ProvisionResult = { ok: false, tenantId: null, subscriptionId: null, host, steps, missing: missingBefore, published: false };
  const step = (s: StepResult) => steps.push({ ...s, detail: s.detail === undefined ? undefined : redactUrls(s.detail) });
  const stop = (s: StepResult): ProvisionResult => {
    step(s);
    return result;
  };

  // 2. Base de datos.
  let pooledUrl: string;
  let directUrl: string;
  let databaseStep: StepResult;
  if (input.database.mode === 'local') {
    const { url, created } = await ensureLocalDatabase(input.database.name);
    pooledUrl = url;
    directUrl = url;
    databaseStep = { step: 'database', status: created ? 'done' : 'skipped', detail: created ? 'BD local creada' : 'La BD local ya existía' };
  } else {
    pooledUrl = input.database.pooledUrl;
    directUrl = input.database.directUrl;
    databaseStep = { step: 'database', status: 'skipped', detail: 'BD ya creada (se usa la indicada)' };
  }

  // 3. Registrar (o reutilizar si el dominio ya es de un cliente con este nombre).
  const existingDomain = await prisma.domain.findUnique({ where: { host }, include: { subscription: { include: { tenant: true } } } });
  const resuming = !!existingDomain && existingDomain.status !== 'RELEASED' && existingDomain.subscription.tenant.name === name;
  if (resuming) {
    // Repetir un alta con OTRA URL de BD no debe migrar y sembrar en silencio la antigua: se avisa (para cambiarla hay `replaceDatabaseUrls`).
    // Se comprueba primero porque no necesita red: con una URL equivocada no hace falta ni intentar conectar.
    const registered = await openField(existingDomain!.subscription.dbUrlDirectEnc, { scope: existingDomain!.subscription.tenantId, field: DB_URL_DIRECT_FIELD });
    if (registered !== directUrl) {
      throw new ServiceError('database_mismatch', 'El cliente ya está registrado con otra URL de BD. Si el primer intento llevaba una URL equivocada, corrígela desde el panel (Sustituir las URLs de conexión) y repite');
    }
  }
  // ANTES de registrar, migrar o sembrar nada: ¿esta BD es nueva, o de este mismo cliente? Con una URL equivocada (la de otro cliente, la de
  // producción de La Grailla) un alta sembraría un administrador conocido en una BD ajena.
  const target = await assertProvisionTarget(directUrl, resuming ? existingDomain!.subscription.tenantId : null, input.adoptDatabase === true);
  step(databaseStep);

  let subscriptionId: string;
  let tenantId: string;
  if (existingDomain && existingDomain.status !== 'RELEASED') {
    if (existingDomain.subscription.tenant.name !== name) {
      throw new ServiceError('domain_taken', `El dominio ${host} ya pertenece a otro cliente`);
    }
    subscriptionId = existingDomain.subscriptionId;
    tenantId = existingDomain.subscription.tenantId;
    step({ step: 'register', status: 'skipped', detail: 'El cliente ya estaba registrado' });
  } else {
    const created = await createTenant(
      { name, productKey: input.productKey ?? 'grailla', primaryHost: host, modules: input.modules, dbUrlPooled: pooledUrl, dbUrlDirect: directUrl, schemaVersion: input.schemaVersion ?? null, dbRegion: input.dbRegion ?? null },
      actor,
      deps.now?.()
    );
    subscriptionId = created.subscription.id;
    tenantId = created.tenant.id;
    step({ step: 'register', status: 'done', detail: `tenantId ${tenantId}` });
  }
  result.subscriptionId = subscriptionId;
  result.tenantId = tenantId;

  // 4. Migrar (el mismo runner que usa el lote; sin republicar: aún no hay nada publicado).
  const migration: MigrationRunResult = await runMigrationsForSubscription(subscriptionId, actor, { ...deps.migrate, republish: false });
  if (migration.status !== 'SUCCEEDED') return stop({ step: 'migrate', status: 'failed', detail: migration.error ?? 'La migración falló' });
  step({ step: 'migrate', status: migration.pending.length ? 'done' : 'skipped', detail: migration.pending.length ? `${migration.pending.length} migraciones → ${migration.toVersion}` : `ya estaba al día (${migration.toVersion})` });

  // 5. Sembrar configuración y primer ADMIN.
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  const dbUrl = await openField(sub.dbUrlDirectEnc, { scope: tenantId, field: DB_URL_DIRECT_FIELD });
  try {
    // Adoptar una BD con usuarios: no se le añade un administrador nuevo (sus usuarios ya existen).
    const createAdmin = !(input.adoptDatabase === true && target.contents.users > 0);
    const seeded = await seedTenantDb(dbUrl, { tenantId, config, adminEmail: adminUserEmail, adminName: input.adminUser?.name?.trim() || 'Administrador', createAdmin });
    if (seeded.adminPassword) {
      result.adminPassword = seeded.adminPassword;
      await deps.onCredentials?.(seeded.adminPassword);
    }
    step({
      step: 'seed',
      status: seeded.configWritten.length || seeded.adminPassword ? 'done' : 'skipped',
      detail: `${seeded.configWritten.length} claves de configuración${seeded.adminPassword ? ' · usuario administrador creado' : ' · el usuario administrador ya existía'}`,
    });
  } catch (err) {
    return stop({ step: 'seed', status: 'failed', detail: err instanceof Error ? err.message : String(err) });
  }

  try {
    await goLiveSteps({ subscriptionId, tenantId, host, dbUrl, actor, domainMode: input.domain ?? 'pending', publish: input.publish !== false, deps, step, result });
  } catch (err) {
    // Un fallo aquí (registro caído, BD, permisos…) no debe perder lo ya hecho ni la contraseña creada: se devuelve como paso fallido.
    step({ step: 'finish', status: 'failed', detail: err instanceof Error ? err.message : String(err) });
  }

  result.ok = !steps.some((s) => s.status === 'failed') && result.published && (!deps.checkHealth || !!result.health?.reachable);
  return result;
}

/**
 * «Salir a producción» de un cliente ya dado de alta (p. ej. tras `allowIncomplete`, cuando él mismo ha completado sus textos legales
 * desde su panel): vuelve a comprobar los datos mínimos EN SU BD, verifica el dominio y publica.
 */
export async function goLiveTenant(
  subscriptionId: string,
  opts: { domain?: 'dns' | 'manual' | 'pending'; publish?: boolean },
  actor: ActingOperator,
  deps: ProvisionDeps = {}
): Promise<ProvisionResult> {
  assertCan(actor.role, 'tenants:write');
  assertCan(actor.role, 'publish');
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { domains: true } });
  if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
  const primary = sub.domains.find((d) => d.isPrimary && d.status !== 'RELEASED') ?? sub.domains.find((d) => d.status !== 'RELEASED');
  if (!primary) throw new ServiceError('no_domain', 'El cliente no tiene ningún dominio');
  if (opts.domain === 'manual') assertCan(actor.role, 'domains:verify-manual');
  const dbUrl = await openField(sub.dbUrlDirectEnc, { scope: sub.tenantId, field: DB_URL_DIRECT_FIELD });
  const steps: StepResult[] = [];
  const result: ProvisionResult = { ok: false, tenantId: sub.tenantId, subscriptionId, host: primary.host, steps, missing: [], published: false };
  await goLiveSteps({ subscriptionId, tenantId: sub.tenantId, host: primary.host, dbUrl, actor, domainMode: opts.domain ?? 'dns', publish: opts.publish !== false, deps, step: (s) => steps.push(s), result });
  result.ok = result.published && !steps.some((s) => s.status === 'failed');
  return result;
}
