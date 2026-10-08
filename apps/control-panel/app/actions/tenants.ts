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

/** Envuelve una acción sobre un tenant: comprueba permiso, ejecuta, refresca la ficha y devuelve el mensaje. */
async function run(
  permission: Parameters<typeof requireOperator>[0],
  tenantId: string,
  body: (actor: Awaited<ReturnType<typeof requireOperator>>['actor']) => Promise<string>
): Promise<ActionState> {
  try {
    const { actor } = await requireOperator(permission);
    const ok = await body(actor);
    revalidatePath(`/tenants/${tenantId}`);
    return { ok };
  } catch (err) {
    return toState(err);
  }
}

export async function setModulesAction(tenantId: string, subscriptionId: string, _p: ActionState, fd: FormData) {
  return run('tenants:write', tenantId, async (actor) => {
    await setModules(subscriptionId, fd.getAll('modules').filter((v): v is string => typeof v === 'string'), actor);
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
      actor
    );
    return 'URLs de la base de datos actualizadas (selladas).';
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
