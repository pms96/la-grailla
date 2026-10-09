import { z } from 'zod';
import { migrationStamp } from '@grailla/contracts';
import { prisma } from '../db';
import { callTenant, type FetchLike, type TenantTarget } from './tenant-calls';

/* Salud básica por cliente (M7): el panel pregunta a `/api/health` de cada cliente con el secreto de cron DE ESE cliente y guarda la
 * última respuesta. La salud «por empuje» (cada cliente avisa) y la telemetría de uso llegan con el umbral de 3 a 5 clientes. */

/** Lo que el front devuelve con el secreto de cron (contrato fijado con el front; campos desconocidos se ignoran). */
export const HealthDetailSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  version: z.string().max(64),
  platform: z.boolean(),
  // El front sirve a este cliente (false = la puerta de esquema lo tiene en mantenimiento). Opcional por compatibilidad con fronts anteriores.
  serving: z.boolean().optional(),
  tenantId: z.string().nullable(),
  // Id de cliente con el que está marcada la BD (si coincide con `tenantId`, bien; si no, la BD es de OTRO cliente). Opcional por compatibilidad.
  tenantMarker: z.string().nullable().optional(),
  db: z.object({ ok: z.boolean(), latencyMs: z.number() }),
  schema: z.object({ applied: z.string().nullable(), expected: z.string(), minRequired: z.string(), upToDate: z.boolean() }),
  onboarding: z.object({ complete: z.boolean(), missing: z.array(z.string()) }),
});
export type HealthDetail = z.infer<typeof HealthDetailSchema>;

export type ProbeResult =
  | { reachable: true; httpStatus: number; latencyMs: number; detail: HealthDetail; problems: string[] }
  | { reachable: false; httpStatus: number | null; latencyMs: number; error: string; problems: string[] };

/** Llama a /api/health y lo interpreta. `declaredSchema` es lo que el registro cree que hay en la BD (para detectar deriva). */
export async function probeTenantHealth(
  target: TenantTarget & { declaredSchema?: string | null },
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const res = await callTenant(target, '/api/health', { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 10_000 });
  if (res.status === null || res.error) {
    return { reachable: false, httpStatus: res.status, latencyMs: res.durationMs, error: res.error ?? 'sin respuesta', problems: ['El cliente no responde'] };
  }
  const parsed = HealthDetailSchema.safeParse(res.body);
  if (!parsed.success) {
    const why = res.status === 401 ? 'el cliente rechazó el secreto de cron (¿PLATFORM_CRON_MASTER distinto en el front?)' : `respuesta no válida (HTTP ${res.status})`;
    return { reachable: false, httpStatus: res.status, latencyMs: res.durationMs, error: why, problems: [why] };
  }
  const d = parsed.data;
  const problems: string[] = [];
  if (!d.db.ok) problems.push('La base de datos no responde');
  // El problema más grave posible en una plataforma multi-cliente: el front de este cliente está leyendo la BD de otro.
  if (d.tenantMarker && d.tenantMarker !== target.tenantId) problems.push(`LA BD ES DE OTRO CLIENTE (marcada como ${d.tenantMarker}): revisa las URLs de BD de este cliente ya`);
  if (d.serving === false) problems.push('El front NO está sirviendo a este cliente (mantenimiento por esquema del registro atrasado): ejecuta el runner de migraciones o corrige la versión del registro');
  if (!d.schema.upToDate) problems.push(`Esquema atrasado: aplicado ${d.schema.applied ?? 'desconocido'}, el front exige ${d.schema.minRequired}`);
  if (target.declaredSchema !== undefined && d.schema.applied && migrationStamp(target.declaredSchema) !== migrationStamp(d.schema.applied)) {
    // El registro cree una versión y la BD tiene otra: el front decide con la del registro, así que conviene corregirlo.
    problems.push(`Deriva: el registro declara ${target.declaredSchema ?? 'ninguna'} y la BD tiene ${d.schema.applied}`);
  }
  if (!d.onboarding.complete) problems.push(`Datos sin completar: ${d.onboarding.missing.join(', ')}`);
  return { reachable: true, httpStatus: res.status, latencyMs: res.durationMs, detail: d, problems };
}

/** Guarda la última comprobación (una fila por suscripción). */
export async function recordHealth(subscriptionId: string, probe: ProbeResult, now: Date = new Date()): Promise<void> {
  const base = {
    checkedAt: now,
    httpStatus: probe.httpStatus,
    latencyMs: probe.latencyMs,
  };
  const data = probe.reachable
    ? {
        ...base,
        ok: probe.detail.status !== 'error' && probe.problems.length === 0,
        status: probe.detail.serving === false ? 'blocked' : probe.problems.length ? 'degraded' : probe.detail.status,
        dbOk: probe.detail.db.ok,
        schemaApplied: probe.detail.schema.applied,
        schemaExpected: probe.detail.schema.expected,
        schemaUpToDate: probe.detail.schema.upToDate,
        onboardingComplete: probe.detail.onboarding.complete,
        onboardingMissing: probe.detail.onboarding.missing,
        version: probe.detail.version,
        error: probe.problems.length ? probe.problems.join(' · ').slice(0, 500) : null,
      }
    : {
        ...base,
        ok: false,
        status: 'unreachable',
        dbOk: null,
        schemaApplied: null,
        schemaExpected: null,
        schemaUpToDate: null,
        onboardingComplete: null,
        onboardingMissing: [] as string[],
        version: null,
        error: probe.error.slice(0, 500),
      };
  await prisma.tenantHealth.upsert({ where: { subscriptionId }, create: { subscriptionId, ...data }, update: data });
}
