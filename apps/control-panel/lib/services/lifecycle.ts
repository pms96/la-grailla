import path from 'node:path';
import type { ActingOperator } from '../actor';
import { prisma } from '../db';
import { diagnoseMigrationEngine, redactUrls } from '../migrations/executor';
import { assertCan } from '../permissions';
import { openField } from '../secrets-store';
import { ServiceError } from './errors';
import { probeTenantHealth, recordHealth } from './health';
import { frontPrismaDir, runMigrationsForSubscription, type MigrationRunResult } from './migrations';
import { goLiveTenant, type ProvisionDeps, type StepResult } from './provision';
import type { FetchLike } from './tenant-calls';
import { DB_URL_DIRECT_FIELD } from './tenants';

/* Lo que hacen los botones de «Puesta en marcha» de la ficha del cliente. Cada función devuelve un resultado en texto para el operador
 * (`ok` y/o `error`, más líneas de detalle) y NUNCA una URL de conexión ni un secreto. La lógica de verdad vive en los servicios que ya
 * usaban los scripts (runner de migraciones, salir a producción, salud): aquí solo se orquestan y se cuentan en claro. */

export type Outcome = { ok?: string; error?: string; details?: string[] };

const MAX_LISTED = 40;
const list = (names: string[]) => (names.length > MAX_LISTED ? [...names.slice(0, MAX_LISTED), `… y ${names.length - MAX_LISTED} más`] : names);

/** Cuenta en claro el resultado de una ejecución del runner. */
export function describeMigration(res: MigrationRunResult): Outcome {
  if (res.status === 'FAILED') {
    return {
      error: `La migración falló: ${redactUrls(res.error ?? 'sin detalle').split('\n').slice(-6).join(' ').slice(0, 400)}`,
      details: [...(res.pending.length ? [`Pendientes: ${res.pending.length}`] : []), ...res.warnings],
    };
  }
  if (res.dryRun) {
    return res.pending.length
      ? { ok: `Hay ${res.pending.length} migraciones por aplicar (desde ${res.fromVersion ?? 'ninguna'}). No se ha cambiado nada.`, details: [...list(res.pending), ...res.warnings] }
      : { ok: 'No hay migraciones pendientes.', details: res.warnings };
  }
  const base = res.pending.length ? `Aplicadas ${res.pending.length} migraciones: ${res.fromVersion ?? 'BD vacía'} → ${res.toVersion}.` : `La BD ya estaba al día (${res.toVersion ?? 'sin migraciones'}).`;
  if (res.republishFailed) {
    return { ok: base, error: 'La BD está migrada, pero no se pudo actualizar el registro publicado: pulsa «Publicar» para que la web del cliente salga del mantenimiento.', details: res.warnings };
  }
  return { ok: `${base} Registro actualizado: la web sale del mantenimiento en unos segundos.`, details: res.warnings };
}

export async function runMigration(subscriptionId: string, dryRun: boolean, actor: ActingOperator): Promise<Outcome> {
  return describeMigration(await runMigrationsForSubscription(subscriptionId, actor, { dryRun }));
}

const STEP_LABEL: Record<string, string> = { onboarding: 'Datos mínimos', domain: 'Dominio', publish: 'Publicación', health: 'Salud de la web', finish: 'Cierre' };
const stepLine = (s: StepResult) => `${s.status === 'done' || s.status === 'skipped' ? '✓' : '✗'} ${STEP_LABEL[s.step] ?? s.step}: ${s.detail ?? s.status}`;

/** «Salir a producción»: comprueba los datos mínimos EN la BD del cliente, verifica el dominio, publica y mira la salud. Repetible. */
export async function runGoLive(subscriptionId: string, opts: { manualDomain?: boolean }, actor: ActingOperator, deps: ProvisionDeps = {}): Promise<Outcome> {
  const result = await goLiveTenant(subscriptionId, { domain: opts.manualDomain ? 'manual' : 'dns' }, actor, { checkHealth: true, ...deps });
  const details = result.steps.map(stepLine);
  if (result.dnsRecord) details.push(`Crea este registro TXT en el DNS del cliente: ${result.dnsRecord.name} → ${result.dnsRecord.value}`);
  if (result.ok) return { ok: 'El cliente está en producción.', details };
  if (result.published) return { error: 'Publicado, pero la web todavía no responde bien: comprueba que el dominio ya apunta a la plataforma y repite.', details };
  return { error: 'Todavía no está en producción: revisa los pasos marcados con ✗ y vuelve a pulsar.', details };
}

/** Pregunta a la web del cliente cómo está y guarda la respuesta. */
export async function runHealthCheck(subscriptionId: string, actor: ActingOperator, deps: { fetchImpl?: FetchLike } = {}): Promise<Outcome> {
  assertCan(actor.role, 'tenants:write');
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { domains: true } });
  if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
  const verified = sub.domains.filter((d) => d.status === 'VERIFIED');
  const host = (verified.find((d) => d.isPrimary) ?? verified[0])?.host;
  if (!host) throw new ServiceError('no_verified_domain', 'Sin un dominio verificado la web no puede responder: verifícalo primero (botón «Salir a producción»).');
  const probe = await probeTenantHealth({ tenantId: sub.tenantId, host, declaredSchema: sub.schemaVersion }, { fetchImpl: deps.fetchImpl });
  await recordHealth(sub.id, probe);
  if (!probe.reachable) return { error: `La web no responde: ${probe.error}`, details: [host] };
  const d = probe.detail;
  const details = [`${host} · HTTP ${probe.httpStatus} · ${probe.latencyMs} ms · versión ${d.version}`, `Esquema aplicado: ${d.schema.applied ?? 'desconocido'} (el front exige ${d.schema.minRequired})`, `Sirviendo al cliente: ${d.serving === false ? 'no' : 'sí'}`];
  return probe.problems.length === 0 ? { ok: 'La web del cliente responde correctamente.', details } : { error: probe.problems.join(' · '), details };
}

/** Diagnóstico del motor de migraciones en este entorno (solo lectura sobre la BD del cliente). */
export async function runEngineCheck(subscriptionId: string, actor: ActingOperator, deps: { prismaDir?: string } = {}): Promise<Outcome> {
  assertCan(actor.role, 'migrations:run');
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
  const directUrl = await openField(sub.dbUrlDirectEnc, { scope: sub.tenantId, field: DB_URL_DIRECT_FIELD });
  const prismaDir = deps.prismaDir ?? frontPrismaDir();
  const diag = await diagnoseMigrationEngine(directUrl, { schemaPath: path.join(prismaDir, 'schema.prisma'), prismaDir });
  return diag.ok ? { ok: 'El motor de migraciones funciona en este entorno.', details: diag.lines } : { error: 'El motor de migraciones NO está listo en este entorno: mira el detalle.', details: diag.lines };
}
