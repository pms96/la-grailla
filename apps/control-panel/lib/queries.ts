import { prisma } from './db';
import { pendingChanges } from './services/snapshot';

export async function listTenants() {
  const tenants = await prisma.tenant.findMany({
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
