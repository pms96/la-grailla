import { AsyncLocalStorage } from 'node:async_hooks';
import { headers } from 'next/headers';
import { PrismaClient } from '@prisma/client';
export const als = new AsyncLocalStorage();
export function withTenant(handler) {
  return (req, ctx) => {
    const tid = req.headers.get('x-tenant-id');
    if (!tid) return new Response('sin tenant', { status: 400 });
    return als.run({ tenantId: tid }, () => handler(req, ctx));
  };
}
// Orden: ALS propio → cabecera de la request en curso (Next).
export function currentTenantId() {
  const s = als.getStore(); if (s) return s.tenantId;
  try { return headers().get('x-tenant-id'); } catch { return null; }
}
const g = globalThis;
g.__clients ??= new Map();
function clientFor(tid) {
  let c = g.__clients.get(tid);
  if (!c) {
    const i = Number(tid.slice(1));
    c = new PrismaClient({ datasources: { db: { url: `postgresql://lagrailla:${process.env.PW}@localhost:5432/spike_t${i}?connection_limit=2` } } });
    g.__clients.set(tid, c);
  }
  return c;
}
export const prisma = new Proxy({}, {
  get(_, prop) {
    const tid = currentTenantId();
    if (!tid) throw new Error('prisma usado sin contexto de tenant (fail-closed)');
    const c = clientFor(tid); const v = c[prop];
    return typeof v === 'function' ? v.bind(c) : v;
  },
});
export const siteName = async () => (await prisma.appConfig.findFirst({ where: { key: 'site_name' } }))?.value;
