import crypto from 'node:crypto';
import type { Domain, Prisma, Subscription, SubscriptionModule, Tenant } from '@prisma/client';
import {
  CONTRACT_VERSION,
  RoutingRecordSchema,
  licensePhase,
  registryKeyForHost,
  registryKeyForSecrets,
  signSecretsSnapshot,
  signSnapshot,
  type RoutingRecord,
} from '@grailla/contracts';
import type { ActingOperator } from '../actor';
import { appendAudit, stableStringify } from '../audit';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import { snapshotSigner, snapshotStaleHours } from '../env';
import { getRegistryStore, type RegistryStore } from '../registry/store';
import { ServiceError } from './errors';

export type SubscriptionFull = Subscription & { tenant: Tenant; modules: SubscriptionModule[]; domains: Domain[] };

/** Registro de enrutado que se publicará para una suscripción. Sin secretos. */
export function buildRoutingRecord(sub: SubscriptionFull, now: number = Date.now()): RoutingRecord {
  const verified = sub.domains.filter((d) => d.status === 'VERIFIED');
  if (verified.length === 0) throw new ServiceError('no_verified_domain', 'No hay ningún dominio verificado: no se puede publicar');
  const primary = verified.find((d) => d.isPrimary) ?? verified[0];
  const status = sub.tenant.status !== 'ACTIVE' ? sub.tenant.status : sub.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
  return RoutingRecordSchema.parse({
    tenantId: sub.tenantId,
    product: sub.productKey,
    cell: sub.cell,
    status,
    modules: sub.modules.map((m) => m.moduleKey).sort(),
    // Fase de licencia ahora + calendario de los cambios futuros: el front los aplica solo mientras el snapshot sea fresco.
    license: licensePhase({ paidThrough: sub.paidThrough ? sub.paidThrough.getTime() : null, graceDays: sub.graceDays, panelBlockedDays: sub.panelBlockedDays }, now),
    primaryDomain: primary.host,
    domains: verified.map((d) => d.host).sort(),
    schemaVersion: sub.schemaVersion,
    epoch: sub.epoch,
  });
}

/** Huella del registro (sin seq ni fechas): permite saber si hay cambios sin publicar. */
export function recordHash(record: RoutingRecord, sub: Pick<Subscription, 'paidThrough' | 'graceDays' | 'panelBlockedDays'>): string {
  // La fase y el calendario del registro dependen del reloj y cambian solos sin que nadie toque nada: lo que cuenta como «cambio»
  // son los PLAZOS. Así «cambios sin publicar» no se enciende por el mero paso del tiempo.
  const terms = { paidThrough: sub.paidThrough ? sub.paidThrough.getTime() : null, graceDays: sub.graceDays, panelBlockedDays: sub.panelBlockedDays };
  return crypto.createHash('sha256').update(stableStringify({ ...record, license: terms })).digest('hex');
}

export async function loadSubscription(db: Prisma.TransactionClient | typeof prisma, id: string): Promise<SubscriptionFull> {
  const sub = await db.subscription.findUnique({ where: { id }, include: { tenant: true, modules: true, domains: true } });
  if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
  return sub;
}

/** ¿Lo que hay publicado coincide con el estado actual? (null si aún no se puede construir) */
export function pendingChanges(sub: SubscriptionFull, now: number = Date.now()): boolean {
  try {
    return recordHash(buildRoutingRecord(sub, now), sub) !== sub.lastPublishedHash;
  } catch {
    return true;
  }
}

export type PublishResult = { seq: number; hosts: string[]; recordHash: string };

/**
 * Firma y publica el registro del cliente en cada dominio verificado, y retira
 * los dominios liberados. Se serializa por suscripción (advisory lock) para que
 * dos publicaciones simultáneas no puedan dejar un seq viejo por encima de uno nuevo.
 * Si el almacén falla, el error se anota y se re-lanza DESPUÉS de confirmar la transacción.
 */
export async function publishSubscription(
  subscriptionId: string,
  actor: ActingOperator,
  store: RegistryStore = getRegistryStore(),
  now: number = Date.now()
): Promise<PublishResult> {
  assertCan(actor.role, 'publish');
  let storeError: Error | null = null;
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subscriptionId}))`;
      const sub = await loadSubscription(tx, subscriptionId);
      const record = buildRoutingRecord(sub, now);
      const hash = recordHash(record, sub);
      const seq = sub.snapshotSeq + 1;
      const body = {
        contractVersion: CONTRACT_VERSION,
        seq,
        iat: now,
        staleUntil: now + snapshotStaleHours() * 3_600_000,
        record,
      };
      const signer = snapshotSigner();
      const envelope = JSON.stringify(await signSnapshot(body, signer));
      // Las URLs de BD (selladas) van en otro registro, firmado con otra etiqueta. Mismo seq que el enrutado.
      const secretsEnvelope = JSON.stringify(
        await signSecretsSnapshot(
          { contractVersion: CONTRACT_VERSION, seq, iat: now, tenantId: sub.tenantId, product: sub.productKey, dbUrlPooledEnc: sub.dbUrlPooledEnc, dbUrlDirectEnc: sub.dbUrlDirectEnc },
          signer
        )
      );
      const hosts = record.domains;
      const released = sub.domains.filter((d) => d.status === 'RELEASED').map((d) => d.host);
      try {
        // Primero los secretos: ningún enrutado debe apuntar a un cliente cuya conexión aún no está publicada.
        await store.put(registryKeyForSecrets(sub.tenantId, sub.productKey), secretsEnvelope);
        for (const host of hosts) await store.put(registryKeyForHost(host), envelope);
        for (const host of released) await store.del(registryKeyForHost(host));
      } catch (err) {
        storeError = err instanceof Error ? err : new Error(String(err));
      }
      if (storeError) {
        await tx.subscription.update({
          where: { id: sub.id },
          data: { snapshotSeq: seq, lastPublishError: storeError.message.slice(0, 500) },
        });
        await appendAudit(tx, {
          actor,
          action: 'subscription.publish_failed',
          targetType: 'subscription',
          targetId: sub.id,
          tenantId: sub.tenantId,
          meta: { seq, error: storeError.message.slice(0, 200) },
        });
        return { seq, hosts, recordHash: hash };
      }
      await tx.subscription.update({
        where: { id: sub.id },
        data: { snapshotSeq: seq, lastPublishedHash: hash, lastPublishedAt: new Date(now), lastPublishError: null },
      });
      await appendAudit(tx, {
        actor,
        action: 'subscription.publish',
        targetType: 'subscription',
        targetId: sub.id,
        tenantId: sub.tenantId,
        meta: { seq, hosts, recordHash: hash },
      });
      return { seq, hosts, recordHash: hash };
    },
    { timeout: 30_000 }
  );
  if (storeError) throw new ServiceError('registry_unavailable', `No se pudo escribir en el registro: ${(storeError as Error).message}`);
  return result;
}

/**
 * Tras un cambio que debe aplicarse YA (suspender un cliente, liberar un dominio), vuelve a publicar
 * las suscripciones del cliente que ya estaban publicadas. Sin esto, el registro seguiría enrutando el
 * dominio liberado o sirviendo al cliente suspendido hasta que alguien pulsase "Publicar".
 * Devuelve los errores (no lanza): el cambio ya está guardado y el operador debe saber si no llegó.
 */
export async function republishIfPublished(tenantId: string, actor: ActingOperator, store: RegistryStore = getRegistryStore()): Promise<string[]> {
  const subs = await prisma.subscription.findMany({ where: { tenantId, lastPublishedAt: { not: null } }, select: { id: true } });
  const errors: string[] = [];
  for (const sub of subs) {
    try {
      await publishSubscription(sub.id, actor, store);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return errors;
}
