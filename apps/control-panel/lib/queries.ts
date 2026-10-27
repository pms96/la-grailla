import { prisma } from './db';
import { hasCriticalOps, splitHealthError } from './services/ops-rules';
import { pendingChanges } from './services/snapshot';

export async function listTenants() {
  // Los retirados (borrado suave) no se listan: solo siguen existiendo para que la auditoría los nombre.
  const tenants = await prisma.tenant.findMany({
    where: { status: { not: 'DELETED' } },
    orderBy: { createdAt: 'desc' },
    include: { subscriptions: { include: { modules: true, domains: true, tenant: true } } },
  });
  return tenants.map((t) => ({
    tenant: t,
    subscriptions: t.subscriptions.map((s) => ({ sub: s, pending: pendingChanges(s) })),
  }));
}

export async function getTenantDetail(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { subscriptions: { include: { modules: true, domains: { orderBy: { createdAt: 'asc' } }, tenant: true, product: { include: { modules: { orderBy: { sortOrder: 'asc' } } } } } } },
  });
  if (!tenant) return null;
  return {
    tenant,
    subscriptions: tenant.subscriptions.map((s) => ({ sub: s, pending: pendingChanges(s) })),
  };
}

export async function recentAudit(opts: { tenantId?: string; take?: number } = {}) {
  return prisma.auditLog.findMany({
    where: opts.tenantId ? { tenantId: opts.tenantId } : {},
    orderBy: { id: 'desc' },
    take: opts.take ?? 100,
  });
}

export async function listOperators() {
  return prisma.operator.findMany({ orderBy: { createdAt: 'asc' } });
}

// ── Salud y operación (M7) ───────────────────────────────────────────────────────────────────────────────────────────────

/** Una comprobación más vieja que esto se considera «sin datos» (el disparador corre cada 5 min). */
export const HEALTH_STALE_MS = 20 * 60_000;
/** El refresco diario de snapshots debería haber publicado hace menos que esto. */
export const PUBLISH_STALE_MS = 36 * 3_600_000;

export type HealthLevel = 'ok' | 'warn' | 'bad' | 'unknown';
export type HealthRow = {
  subscriptionId: string;
  tenantId: string;
  name: string;
  host: string | null;
  level: HealthLevel;
  problems: string[];
  checkedAt: Date | null;
  latencyMs: number | null;
  version: string | null;
  schemaApplied: string | null;
  schemaDeclared: string | null;
  onboardingMissing: string[];
  crons: { job: string; lastSuccessAt: Date | null; failures: number; lastError: string | null }[];
  lastMigration: { status: string; at: Date; error: string | null } | null;
};

type AssessInput = {
  published: boolean;
  publishedAt: Date | null;
  health: { checkedAt: Date; ok: boolean; status: string; error: string | null } | null;
  crons: { job: string; consecutiveFailures: number; lastError: string | null }[];
  lastMigration: { status: string; error: string | null } | null;
};

/** Pura: qué está mal y con qué gravedad (testable sin BD). */
export function assessSubscription(i: AssessInput, now: number = Date.now()): { level: HealthLevel; problems: string[] } {
  if (!i.published) return { level: 'unknown', problems: ['Sin publicar: todavía no recibe tráfico'] };
  const problems: string[] = [];
  let level: HealthLevel = 'ok';
  const raise = (l: HealthLevel) => {
    const order: HealthLevel[] = ['ok', 'unknown', 'warn', 'bad'];
    if (order.indexOf(l) > order.indexOf(level)) level = l;
  };
  if (!i.health) {
    problems.push('Aún sin comprobación de salud');
    raise('unknown');
  } else if (now - i.health.checkedAt.getTime() > HEALTH_STALE_MS) {
    problems.push('La última comprobación de salud es antigua: ¿el disparador de crons está corriendo?');
    raise('warn');
  } else if (i.health.status === 'blocked') {
    problems.push(i.health.error ?? 'El front no sirve a este cliente');
    raise('bad');
  } else if (i.health.status === 'unreachable') {
    // `error` puede llevar, además del motivo, las señales de operación que se conservan durante la caída: se muestran aparte.
    const { ops, other } = splitHealthError(i.health.error);
    problems.push(`No responde: ${other.join(' · ') || 'sin detalle'}`, ...ops);
    raise('bad');
  } else if (!i.health.ok) {
    // `error` junta, separadas por « · », las señales de operación (P0-07) y los problemas técnicos: cada una es un problema aparte.
    problems.push(...(i.health.error ?? 'Degradado').split(' · ').map((p) => p.trim()).filter(Boolean));
    // Una señal de operación de gravedad «fallo» (pedidos sin resolver, emails con error, reconcile caído) pinta en rojo.
    raise(i.health.status === 'error' || hasCriticalOps(i.health.error) ? 'bad' : 'warn');
  }
  for (const c of i.crons) {
    if (c.consecutiveFailures >= 3) {
      problems.push(`Tarea ${c.job} falla desde hace ${c.consecutiveFailures} ejecuciones${c.lastError ? `: ${c.lastError}` : ''}`);
      raise('bad');
    } else if (c.consecutiveFailures > 0 && c.job !== 'health') {
      problems.push(`Tarea ${c.job} falló la última vez${c.lastError ? `: ${c.lastError}` : ''}`);
      raise('warn');
    }
  }
  if (i.lastMigration?.status === 'FAILED') {
    problems.push(`La última migración falló${i.lastMigration.error ? `: ${i.lastMigration.error.split('\n')[0]}` : ''}`);
    raise('bad');
  }
  if (!i.publishedAt || now - i.publishedAt.getTime() > PUBLISH_STALE_MS) {
    problems.push('El registro lleva más de 36 h sin republicarse: ejecuta el refresco de snapshots (la licencia dejaría de avanzar)');
    raise('warn');
  }
  return { level, problems };
}

export async function healthOverview(now: number = Date.now()): Promise<HealthRow[]> {
  const subs = await prisma.subscription.findMany({
    where: { tenant: { status: { in: ['ACTIVE', 'SUSPENDED'] } } },
    orderBy: { createdAt: 'asc' },
    include: {
      tenant: true,
      domains: { where: { status: 'VERIFIED' } },
      health: true,
      cronStates: true,
      migrationRuns: { orderBy: { startedAt: 'desc' }, take: 1 },
    },
  });
  const rows: HealthRow[] = subs.map((s) => {
    const lastRun = s.migrationRuns[0] ?? null;
    const crons = s.cronStates.map((c) => ({ job: c.job, lastSuccessAt: c.lastSuccessAt, failures: c.consecutiveFailures, lastError: c.lastError })).sort((a, b) => a.job.localeCompare(b.job));
    const { level, problems } = assessSubscription(
      {
        published: s.lastPublishedAt !== null,
        publishedAt: s.lastPublishedAt,
        health: s.health ? { checkedAt: s.health.checkedAt, ok: s.health.ok, status: s.health.status, error: s.health.error } : null,
        crons: s.cronStates.map((c) => ({ job: c.job, consecutiveFailures: c.consecutiveFailures, lastError: c.lastError })),
        lastMigration: lastRun ? { status: lastRun.status, error: lastRun.error } : null,
      },
      now
    );
    return {
      subscriptionId: s.id,
      tenantId: s.tenantId,
      name: s.tenant.name,
      host: (s.domains.find((d) => d.isPrimary) ?? s.domains[0])?.host ?? null,
      level,
      problems,
      checkedAt: s.health?.checkedAt ?? null,
      latencyMs: s.health?.latencyMs ?? null,
      version: s.health?.version ?? null,
      schemaApplied: s.health?.schemaApplied ?? null,
      schemaDeclared: s.schemaVersion,
      onboardingMissing: s.health?.onboardingMissing ?? [],
      crons,
      lastMigration: lastRun ? { status: lastRun.status, at: lastRun.startedAt, error: lastRun.error } : null,
    };
  });
  // Lo que necesita atención, primero.
  const weight: Record<HealthLevel, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 };
  return rows.sort((a, b) => weight[a.level] - weight[b.level] || a.name.localeCompare(b.name));
}

/** Operación de una suscripción: última salud, estado de cada tarea y últimas migraciones. */
export async function getOperations(subscriptionId: string) {
  const [health, crons, runs] = await Promise.all([
    prisma.tenantHealth.findUnique({ where: { subscriptionId } }),
    prisma.cronState.findMany({ where: { subscriptionId }, orderBy: { job: 'asc' } }),
    prisma.migrationRun.findMany({ where: { subscriptionId }, orderBy: { startedAt: 'desc' }, take: 5 }),
  ]);
  return { health, crons, runs };
}
