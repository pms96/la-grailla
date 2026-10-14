import { registryKeyForHost, registryKeyForRevocation, registryKeyForSecrets } from '@grailla/contracts';
import type { ActingOperator } from '../actor';
import { appendAudit } from '../audit';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import { getRegistryStore, type RegistryStore } from '../registry/store';
import { ServiceError } from './errors';

/* «Retirar cliente»: la forma de quitar del panel un cliente que ya no existe (un ensayo, una baja). Es un borrado SUAVE a propósito:
 *
 *  - La fila del cliente se queda con estado DELETED, porque la auditoría (que la BD no deja modificar) lo nombra y debe seguir
 *    teniendo sentido. Desaparece de los listados, de la salud, de los crons, del refresco de snapshots y de las migraciones.
 *  - Se borran del registro sus dominios, sus URLs de BD selladas y su revocación: la web deja de resolverse (404) y no queda ningún
 *    secreto suyo publicado. En el panel se vacían las URLs selladas y la huella de la BD, así esa BD puede volver a registrarse.
 *  - Los dominios quedan como «liberados» (lápida): nadie puede reclamarlos al instante (DOMAIN_COOLDOWN_DAYS).
 *  - NO se toca la BD del cliente en Neon: el panel nunca la crea ni la borra. Se elimina a mano en Neon.
 *
 * Doble seguro contra un borrado por error: el cliente tiene que estar SUSPENDIDO (la web ya cortada) y hay que escribir su nombre exacto.
 * Repetible: si se corta a medias, se vuelve a pulsar. Primero se limpia el registro y solo después se cambia el panel, así un fallo del
 * registro no deja un cliente «borrado» cuya web sigue sirviéndose. */

export type RetireResult = { tenantId: string; name: string; hosts: string[]; alreadyRetired: boolean };

export async function retireTenant(tenantId: string, opts: { confirmName: string }, actor: ActingOperator, store: RegistryStore = getRegistryStore(), now: number = Date.now()): Promise<RetireResult> {
  assertCan(actor.role, 'tenants:write');
  assertCan(actor.role, 'database:write');

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { subscriptions: { include: { domains: true } } } });
  if (!tenant) throw new ServiceError('not_found', 'Cliente no encontrado');
  const hosts = tenant.subscriptions.flatMap((s) => s.domains.map((d) => d.host));
  if (tenant.status === 'DELETED') return { tenantId, name: tenant.name, hosts, alreadyRetired: true };
  if (tenant.status !== 'SUSPENDED') throw new ServiceError('suspend_first', 'Suspende el cliente antes de retirarlo: así su web queda cortada y nadie retira un cliente en marcha por error.');
  if ((opts.confirmName ?? '').trim() !== tenant.name) throw new ServiceError('confirm_mismatch', 'Para retirarlo, escribe el nombre del cliente exactamente como aparece.');

  // 1. Registro: ya no debe enrutar ni guardar nada de este cliente.
  try {
    for (const sub of tenant.subscriptions) {
      for (const d of sub.domains) await store.del(registryKeyForHost(d.host));
      await store.del(registryKeyForSecrets(tenant.id, sub.productKey));
    }
    await store.del(registryKeyForRevocation(tenant.id));
  } catch (err) {
    throw new ServiceError('registry_unavailable', `No se pudo limpiar el registro: ${err instanceof Error ? err.message : err}. No se ha cambiado nada en el panel: repite cuando el registro responda.`);
  }

  // 2. Panel.
  await prisma.$transaction(async (tx) => {
    for (const sub of tenant.subscriptions) {
      await tx.cronState.deleteMany({ where: { subscriptionId: sub.id } });
      await tx.tenantHealth.deleteMany({ where: { subscriptionId: sub.id } });
      await tx.domain.updateMany({ where: { subscriptionId: sub.id, status: { not: 'RELEASED' } }, data: { status: 'RELEASED', releasedAt: new Date(now), isPrimary: false } });
      await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'SUSPENDED', dbUrlPooledEnc: '', dbUrlDirectEnc: '', dbFingerprint: null, lastPublishedAt: null, lastPublishedHash: null, lastPublishError: null },
      });
    }
    await tx.tenant.update({ where: { id: tenant.id }, data: { status: 'DELETED', emergencyRevokedAt: null } });
    await appendAudit(tx, {
      actor,
      action: 'tenant.retire',
      targetType: 'tenant',
      targetId: tenant.id,
      tenantId: tenant.id,
      // Nombres de dominio y un recuento: nada de URLs de BD.
      meta: { name: tenant.name, from: tenant.status, subscriptions: tenant.subscriptions.length, hosts },
    });
  });
  return { tenantId, name: tenant.name, hosts, alreadyRetired: false };
}
