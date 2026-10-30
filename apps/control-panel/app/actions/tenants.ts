'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireOperator } from '@/lib/guard';
import {
  addDomain,
  releaseDomain,
  setPrimaryDomain,
  verifyDomainDns,
  verifyDomainManually,
} from '@/lib/services/domains';
import { publishSubscription, republishIfPublished } from '@/lib/services/snapshot';
import { ServiceError } from '@/lib/services/errors';
import type { ActingOperator } from '@/lib/actor';
import { bumpEpoch, createTenant, replaceDatabaseUrls, setModules, setTenantStatus } from '@/lib/services/tenants';
import { emergencyRevoke, liftEmergencyRevocation, redeemLicenseKey, registerPayment, setLicenseTerms } from '@/lib/services/license';
import { describeProvision, describeSeed, runEngineCheck, runGoLive, runHealthCheck, runInvite, runMigration, type Outcome } from '@/lib/services/lifecycle';
import { prisma } from '@/lib/db';
import { provisionTenant, type ProvisionInput } from '@/lib/services/provision';
import { seedExistingTenant } from '@/lib/services/tenant-setup';
import { retireTenant } from '@/lib/services/retire';
import { describeDomainSetup, ensureVercelDomain, vercelConfig } from '@/lib/services/vercel-domains';
import type { ActionState } from '../_components/action-form';
import { str, toState } from './util';

export async function createTenantAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let tenantId: string;
  try {
    const { actor } = await requireOperator('database:write');
    const result = await createTenant(
      {
        name: str(fd, 'name'),
        productKey: str(fd, 'productKey') || 'grailla',
        primaryHost: str(fd, 'primaryHost'),
        modules: fd.getAll('modules').filter((v): v is string => typeof v === 'string'),
        dbUrlPooled: str(fd, 'dbUrlPooled'),
        dbUrlDirect: str(fd, 'dbUrlDirect'),
        schemaVersion: str(fd, 'schemaVersion') || null,
        dbRegion: str(fd, 'dbRegion') || null,
      },
      actor
    );
    tenantId = result.tenant.id;
  } catch (err) {
    return toState(err);
  }
  redirect(`/tenants/${tenantId}`);
}

/** Qué hacer con el dominio en Vercel tras un alta: añadirlo por API si el panel tiene el token, o decir cómo hacerlo a mano. */
async function vercelDomainLines(host: string): Promise<string[]> {
  if (host.endsWith('.vercel.app')) return ['Dominio de Vercel (*.vercel.app): no hace falta añadirlo ni crear DNS.'];
  const cfg = vercelConfig();
  if (!cfg) {
    return ['Dominio en Vercel: añádelo a mano en el proyecto grailla-platform (Settings → Domains), o configura VERCEL_API_TOKEN y VERCEL_PLATFORM_PROJECT_ID en el panel para hacerlo desde aquí.'];
  }
  try {
    return describeDomainSetup(await ensureVercelDomain(host, cfg));
  } catch (err) {
    return [`✗ Vercel: ${err instanceof ServiceError ? err.message : 'error inesperado, mira los registros del servidor'}`];
  }
}

/** Invita al administrador y suma el resultado al de otra acción. Un fallo aquí (p. ej. dominio aún sin verificar) no estropea lo ya hecho. */
async function withInvitation(base: Outcome, subscriptionId: string, actor: ActingOperator): Promise<Outcome> {
  try {
    const inv = await runInvite(subscriptionId, {}, actor);
    return { ...base, details: [...(base.details ?? []), ...(inv.ok ? [`✓ Invitación: ${inv.ok}`] : []), ...(inv.error ? [`✗ Invitación: ${inv.error}`] : [])], reveal: inv.reveal ?? base.reveal };
  } catch (err) {
    const why = err instanceof ServiceError ? err.message : 'error inesperado, mira los registros del servidor';
    return { ...base, details: [...(base.details ?? []), `✗ Invitación: ${why}. Cuando esté listo, pulsa «Enviar invitación» en la ficha del cliente.`] };
  }
}

/** «Retirar cliente»: borrado suave (ver lib/services/retire.ts). Tras retirarlo, su ficha ya no tiene nada que hacer: se vuelve a la lista. */
export async function retireTenantAction(tenantId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { actor } = await requireOperator('database:write');
    await retireTenant(tenantId, { confirmName: str(fd, 'confirmName') }, actor);
  } catch (err) {
    return toState(err);
  }
  revalidatePath('/');
  redirect('/?retired=1');
}

/** Asistente de alta: registra, migra, siembra, verifica el dominio y publica (el mismo servicio que `npm run tenant:provision`). Repetible. */
export async function provisionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { actor } = await requireOperator('database:write');
    const mode = str(fd, 'domainMode');
    const adminEmail = str(fd, 'adminEmail');
    const input: ProvisionInput = {
      name: str(fd, 'name'),
      productKey: 'grailla',
      primaryHost: str(fd, 'primaryHost'),
      modules: fd.getAll('modules').filter((v): v is string => typeof v === 'string'),
      adminEmail,
      adminUser: { email: str(fd, 'adminUserEmail') || undefined, name: str(fd, 'adminName') || undefined },
      legal: { legal_notice: str(fd, 'legal_notice'), privacy_policy: str(fd, 'privacy_policy'), cookies_policy: str(fd, 'cookies_policy') },
      database: { mode: 'existing', pooledUrl: str(fd, 'dbUrlPooled'), directUrl: str(fd, 'dbUrlDirect') },
      domain: mode === 'manual' || mode === 'pending' ? mode : 'dns',
      publish: str(fd, 'publish') === 'on',
      allowIncomplete: str(fd, 'allowIncomplete') === 'on',
      dbRegion: str(fd, 'dbRegion') || null,
    };
    // Sin comprobar la salud: en un alta el dominio todavía no apunta a la plataforma. Se comprueba desde la ficha cuando el DNS esté.
    const result = await provisionTenant(input, actor);
    const extra = result.tenantId ? await vercelDomainLines(result.host) : [];
    revalidatePath('/');
    // Con «invitar», la contraseña temporal no se enseña: el administrador fija la suya. La invitación solo sale si el dominio ya está verificado.
    const invite = str(fd, 'invite') === 'on';
    const outcome = describeProvision(result, { adminEmail: (input.adminUser?.email || adminEmail).trim().toLowerCase(), extra, invite });
    return invite && result.subscriptionId ? withInvitation(outcome, result.subscriptionId, actor) : outcome;
  } catch (err) {
    return toState(err);
  }
}

/** Envuelve una acción sobre un tenant: comprueba permiso, ejecuta, refresca la ficha y devuelve el mensaje. */
async function run(
  permission: Parameters<typeof requireOperator>[0],
  tenantId: string,
  body: (actor: Awaited<ReturnType<typeof requireOperator>>['actor']) => Promise<string | Outcome>
): Promise<ActionState> {
  try {
    const { actor } = await requireOperator(permission);
    const result = await body(actor);
    revalidatePath(`/tenants/${tenantId}`);
    return typeof result === 'string' ? { ok: result } : result;
  } catch (err) {
    return toState(err);
  }
}

// ── Puesta en marcha ───────────────────────────────────────────────────────

/** Aplica (o, con `dryRun`, solo lista) las migraciones pendientes de la BD de este cliente. */
export async function migrateAction(tenantId: string, subscriptionId: string, dryRun: boolean, _p: ActionState) {
  return run('migrations:run', tenantId, (actor) => runMigration(subscriptionId, dryRun, actor));
}

/** Datos mínimos → dominio → publicar → salud. Repetible: si falta algo, dice qué y se vuelve a pulsar. */
export async function goLiveAction(tenantId: string, subscriptionId: string, _p: ActionState, fd: FormData) {
  return run('publish', tenantId, (actor) => runGoLive(subscriptionId, { manualDomain: str(fd, 'manualDomain') === 'on' }, actor));
}

/** Datos iniciales de un cliente ya registrado: email de avisos, textos legales y primer administrador de su web. */
export async function seedTenantAction(tenantId: string, subscriptionId: string, _p: ActionState, fd: FormData) {
  return run('database:write', tenantId, async (actor) => {
    const invite = str(fd, 'invite') === 'on';
    const seed = await seedExistingTenant(
      subscriptionId,
      {
        adminEmail: str(fd, 'adminEmail'),
        adminName: str(fd, 'adminName') || undefined,
        adminUserEmail: str(fd, 'adminUserEmail') || undefined,
        legal: { legal_notice: str(fd, 'legal_notice'), privacy_policy: str(fd, 'privacy_policy'), cookies_policy: str(fd, 'cookies_policy') },
      },
      actor
    );
    const outcome = describeSeed(seed, { invite });
    return invite ? withInvitation(outcome, subscriptionId, actor) : outcome;
  });
}

/** «Enviar invitación»: el administrador de la web del cliente fija su contraseña con un enlace de un solo uso (por correo si el panel lo tiene). */
export async function inviteAdminAction(tenantId: string, subscriptionId: string, _p: ActionState) {
  return run('database:write', tenantId, (actor) => runInvite(subscriptionId, {}, actor));
}

/** Añade el dominio al proyecto de Vercel de la plataforma (si el panel tiene el token) y dice qué registro DNS crear. */
export async function vercelDomainAction(tenantId: string, domainId: string, _p: ActionState) {
  return run('tenants:write', tenantId, async (): Promise<Outcome> => {
    const cfg = vercelConfig();
    if (!cfg) throw new ServiceError('vercel_not_configured', 'Falta configurar VERCEL_API_TOKEN y VERCEL_PLATFORM_PROJECT_ID en el panel.');
    const domain = await prisma.domain.findUnique({ where: { id: domainId }, include: { subscription: { select: { tenantId: true } } } });
    if (!domain || domain.subscription.tenantId !== tenantId || domain.status === 'RELEASED') throw new ServiceError('not_found', 'Dominio no encontrado');
    const setup = await ensureVercelDomain(domain.host, cfg);
    return { ok: setup.misconfigured === false && setup.records.length === 0 ? 'El dominio está en Vercel y el DNS ya apunta bien.' : 'El dominio está en Vercel. Falta lo que se indica abajo.', details: describeDomainSetup(setup) };
  });
}

export async function checkHealthAction(tenantId: string, subscriptionId: string, _p: ActionState) {
  return run('tenants:write', tenantId, (actor) => runHealthCheck(subscriptionId, actor));
}

/** Diagnóstico: ¿puede este entorno aplicar migraciones? Solo lectura. */
export async function engineCheckAction(tenantId: string, subscriptionId: string, _p: ActionState) {
  return run('migrations:run', tenantId, (actor) => runEngineCheck(subscriptionId, actor));
}

export async function setModulesAction(tenantId: string, subscriptionId: string, _p: ActionState, fd: FormData) {
  return run('tenants:write', tenantId, async (actor) => {
    const reason = str(fd, 'overrideReason');
    await setModules(subscriptionId, fd.getAll('modules').filter((v): v is string => typeof v === 'string'), actor, reason ? { override: { reason } } : {});
    return 'Módulos guardados. Publica para que lleguen a la web del cliente.';
  });
}

export async function addDomainAction(tenantId: string, subscriptionId: string, _p: ActionState, fd: FormData) {
  return run('tenants:write', tenantId, async (actor) => {
    await addDomain(subscriptionId, str(fd, 'host'), actor);
    return 'Dominio añadido. Falta verificarlo.';
  });
}

export async function verifyDnsAction(tenantId: string, domainId: string, _p: ActionState) {
  return run('tenants:write', tenantId, async (actor) => {
    await verifyDomainDns(domainId, actor);
    return 'Dominio verificado por DNS.';
  });
}

export async function verifyManualAction(tenantId: string, domainId: string, _p: ActionState) {
  return run('domains:verify-manual', tenantId, async (actor) => {
    await verifyDomainManually(domainId, actor);
    return 'Dominio marcado como verificado a mano (queda auditado).';
  });
}

export async function setPrimaryAction(tenantId: string, domainId: string, _p: ActionState) {
  return run('tenants:write', tenantId, async (actor) => {
    await setPrimaryDomain(domainId, actor);
    return 'Dominio principal actualizado.';
  });
}

/** Cambios que no pueden esperar a un "Publicar" manual: se aplican ya y, si el registro falla, se avisa. */
async function applyNow(tenantId: string, actor: ActingOperator, done: string): Promise<string> {
  const errors = await republishIfPublished(tenantId, actor);
  if (errors.length) throw new ServiceError('publish_failed', `El cambio está guardado, pero NO se pudo publicar: ${errors.join('; ')}. Reintenta con "Publicar".`);
  return `${done} Ya publicado.`;
}

export async function releaseDomainAction(tenantId: string, domainId: string, _p: ActionState) {
  return run('tenants:write', tenantId, async (actor) => {
    await releaseDomain(domainId, actor);
    return applyNow(tenantId, actor, 'Dominio liberado (reservado 30 días si estaba verificado).');
  });
}

export async function publishAction(tenantId: string, subscriptionId: string, _p: ActionState) {
  return run('publish', tenantId, async (actor) => {
    const r = await publishSubscription(subscriptionId, actor);
    return `Publicado (versión ${r.seq}) en ${r.hosts.length} dominio${r.hosts.length === 1 ? '' : 's'}.`;
  });
}

export async function setStatusAction(tenantId: string, status: 'ACTIVE' | 'SUSPENDED', _p: ActionState) {
  return run('tenants:write', tenantId, async (actor) => {
    await setTenantStatus(tenantId, status, actor);
    return applyNow(tenantId, actor, status === 'SUSPENDED' ? 'Cliente suspendido.' : 'Cliente reactivado.');
  });
}

export async function bumpEpochAction(tenantId: string, subscriptionId: string, _p: ActionState) {
  return run('tenants:write', tenantId, async (actor) => {
    await bumpEpoch(subscriptionId, actor);
    return 'Época subida. Al publicar se cerrarán las sesiones del cliente.';
  });
}

export async function replaceDbAction(tenantId: string, subscriptionId: string, _p: ActionState, fd: FormData) {
  return run('database:write', tenantId, async (actor) => {
    await replaceDatabaseUrls(
      subscriptionId,
      { pooled: str(fd, 'pooled'), direct: str(fd, 'direct'), schemaVersion: str(fd, 'schemaVersion') || undefined },
      actor,
      { checkMarker: true }
    );
    // Se publica ya: el front lee las URLs del registro, y hasta el refresco diario seguiría usando la BD antigua (que quizá se desmantele).
    return applyNow(tenantId, actor, 'URLs de la base de datos actualizadas (selladas).');
  });
}

// ── Licencia ───────────────────────────────────────────────────────────────

/** `yyyy-mm-dd` del formulario → el final de ese día en Madrid (23:59:59), para que «hasta el 30» incluya el día 30. */
function endOfDayMadrid(value: string): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ServiceError('invalid_license', 'Fecha no válida');
  const [y, m, d] = value.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  // `2026-02-31` no es una fecha: JavaScript la «arreglaría» al 3 de marzo sin avisar.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new ServiceError('invalid_license', 'Fecha no válida');
  const probe = new Date(`${value}T12:00:00Z`);
  const offsetHours = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'shortOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1';
  const hours = Number(offsetHours.replace('GMT', '') || 0);
  return new Date(Date.parse(`${value}T23:59:59.000Z`) - hours * 3_600_000);
}

export async function setLicenseAction(tenantId: string, subscriptionId: string, _p: ActionState, fd: FormData) {
  return run('billing:write', tenantId, async (actor) => {
    await setLicenseTerms(
      subscriptionId,
      { paidThrough: endOfDayMadrid(str(fd, 'paidThrough')), graceDays: Number(str(fd, 'graceDays')), panelBlockedDays: Number(str(fd, 'panelBlockedDays')) },
      actor
    );
    return applyNow(tenantId, actor, 'Licencia actualizada.');
  });
}

export async function registerPaymentAction(tenantId: string, subscriptionId: string, _p: ActionState, fd: FormData) {
  return run('billing:write', tenantId, async (actor) => {
    const next = await registerPayment(subscriptionId, Number(str(fd, 'days')), actor);
    return applyNow(tenantId, actor, `Pago registrado: cubierto hasta el ${new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(next)}.`);
  });
}

export async function redeemKeyAction(tenantId: string, subscriptionId: string, _p: ActionState, fd: FormData) {
  return run('billing:write', tenantId, async (actor) => {
    const r = await redeemLicenseKey(subscriptionId, str(fd, 'code'), actor);
    const parts = [r.added.length ? `módulos activados: ${r.added.join(', ')}` : null, r.paidThrough ? `cubierto hasta el ${new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(r.paidThrough)}` : null].filter(Boolean);
    return applyNow(tenantId, actor, `Clave canjeada${parts.length ? ` (${parts.join('; ')})` : ''}.`);
  });
}

/** Revocación de emergencia: corta al cliente en segundos, sin republicar. */
export async function emergencyRevokeAction(tenantId: string, _p: ActionState) {
  return run('tenants:revoke', tenantId, async (actor) => {
    await emergencyRevoke(tenantId, actor);
    return 'Acceso revocado. El front corta a este cliente en unos segundos (webhooks y crons siguen entrando).';
  });
}

export async function liftRevocationAction(tenantId: string, _p: ActionState) {
  return run('tenants:revoke', tenantId, async (actor) => {
    await liftEmergencyRevocation(tenantId, actor);
    return 'Revocación levantada. El cliente vuelve a servirse en unos segundos.';
  });
}
