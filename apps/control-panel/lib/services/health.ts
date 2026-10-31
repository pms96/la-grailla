import { z } from 'zod';
import { migrationStamp, parseOpsBlock, type OpsBlock } from '@grailla/contracts';
import { prisma } from '../db';
import { callTenant, type FetchLike, type TenantTarget } from './tenant-calls';
import { OPS_PREFIX, evaluateOps, markUnalerted, splitHealthError, type OpsEvaluation, type OpsKey } from './ops-rules';

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
  // Señales de negocio (P0-07). Opcional por compatibilidad con fronts anteriores, y NO se valida aquí: un bloque mal formado no puede dejar al
  // cliente como «no responde». Se lee con `parseOpsBlock` (contrato) y, si no lo cumple, se avisa como problema aparte.
  ops: z.unknown().optional(),
});
export type HealthDetail = z.infer<typeof HealthDetailSchema>;

export type ProbeResult =
  | { reachable: true; httpStatus: number; latencyMs: number; detail: HealthDetail; problems: string[]; /** Bloque `ops` válido del cliente (ausente en fronts anteriores). */ ops?: OpsBlock | null; /** Por qué `ops` es null: `absent` = front anterior sin el bloque; `invalid` = lo manda y no cumple el contrato. */ opsStatus?: 'ok' | 'absent' | 'invalid' }
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
  const opsRead = parseOpsBlock(d.ops);
  // Un `ops` que no cumple el contrato es un fallo del front (versión desfasada o un bug), no del cliente: se dice, sin copiar lo recibido.
  if (opsRead.status === 'invalid') problems.push(`El bloque «ops» de la salud no cumple el contrato (${opsRead.issue}): las señales de negocio de este cliente no se están vigilando`);
  return { reachable: true, httpStatus: res.status, latencyMs: res.durationMs, detail: d, problems, ops: opsRead.status === 'ok' ? opsRead.ops : null, opsStatus: opsRead.status };
}

/** ¿Está sano TÉCNICAMENTE? Responde, sin error declarado por el propio cliente y sin problemas (esquema atrasado, BD de otro cliente…). Las señales de negocio (`ops`) se tratan aparte. */
export function isHealthy(probe: ProbeResult): boolean {
  return probe.reachable && probe.detail.status !== 'error' && probe.problems.length === 0;
}

/**
 * Guarda la última comprobación (una fila por suscripción). Si el cliente manda `ops`, aplica las reglas de negocio (ops-rules.ts) contra el
 * estado anterior y deja las señales activas como líneas «Operación: …» en `error` (la ficha y Salud ya lo muestran; es además la memoria con la
 * que se avisa solo en el cambio). Devuelve la evaluación para que el disparador avise, o null si no hay `ops`.
 */
export async function recordHealth(subscriptionId: string, probe: ProbeResult, now: Date = new Date()): Promise<OpsEvaluation | null> {
  const base = {
    checkedAt: now,
    httpStatus: probe.httpStatus,
    latencyMs: probe.latencyMs,
  };
  const previous = await prisma.tenantHealth.findUnique({ where: { subscriptionId }, select: { error: true } });
  let evaluation: OpsEvaluation | null = null;
  if (probe.reachable && probe.ops) evaluation = evaluateOps(probe.ops, now.getTime(), previous?.error ?? null);
  // Sin lectura de `ops` en esta pasada (el cliente no responde, o `ops` falta, es nulo o no es válido) NO se sabe si las señales siguen o no: se
  // CONSERVAN las líneas anteriores tal cual. Borrarlas haría que al volver el cliente se avisara otra vez de lo ya avisado, o que se perdiera el
  // «recuperado» de lo que se resolvió durante la caída.
  const opsLines = evaluation ? evaluation.findings.map((f) => f.line) : splitHealthError(previous?.error).ops;
  const data = probe.reachable
    ? {
        ...base,
        ok: probe.detail.status !== 'error' && probe.problems.length === 0 && opsLines.length === 0,
        status: probe.detail.serving === false ? 'blocked' : probe.problems.length || opsLines.length ? 'degraded' : probe.detail.status,
        dbOk: probe.detail.db.ok,
        schemaApplied: probe.detail.schema.applied,
        schemaExpected: probe.detail.schema.expected,
        schemaUpToDate: probe.detail.schema.upToDate,
        onboardingComplete: probe.detail.onboarding.complete,
        onboardingMissing: probe.detail.onboarding.missing,
        version: probe.detail.version,
        // Las señales de operación primero (lo que toca dinero es lo más urgente y no debe quedar cortado por el límite).
        error: [...opsLines, ...probe.problems].length ? [...opsLines, ...probe.problems].join(' · ').slice(0, 1200) : null,
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
        error: [...opsLines, probe.error.slice(0, 500)].join(' · ').slice(0, 1200),
      };
  await prisma.tenantHealth.upsert({ where: { subscriptionId }, create: { subscriptionId, ...data }, update: data });
  return evaluation;
}

/** ¿Las señales de operación (y solo ellas) son la causa de que la última comprobación no fuera «ok»? Entonces la parte técnica estaba bien. */
export function wasOnlyOpsDegraded(previous: { ok: boolean; status: string; error: string | null }): boolean {
  if (previous.ok || previous.status !== 'degraded' || !previous.error) return false;
  return previous.error.split(' · ').every((p) => p.trim().startsWith(OPS_PREFIX));
}

/** El aviso de estas señales no llegó a salir: se marcan para volver a avisar en la siguiente pasada en lugar de darlas por avisadas. */
export async function markOpsUnalerted(subscriptionId: string, keys: OpsKey[]): Promise<void> {
  const row = await prisma.tenantHealth.findUnique({ where: { subscriptionId }, select: { error: true } });
  const next = markUnalerted(row?.error, keys);
  if (row && next !== row.error) await prisma.tenantHealth.update({ where: { subscriptionId }, data: { error: next } });
}
