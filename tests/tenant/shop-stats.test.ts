import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getShopStats } from '@/lib/shop-stats';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Dashboard de la tienda (M6): solo cuenta lo cobrado y no anulado, por cliente. */

let sessionRole: 'ADMIN' | 'TAQUILLA' | null = 'ADMIN';
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'u1', role: sessionRole } } : null)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

let env: ReturnType<typeof enablePlatformEnv>;
let route: typeof import('@/app/api/admin/shop-stats/route');
const NOW = new Date('2026-10-08T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function seed(slot: 'a' | 'b') {
  const db = tenantClient(slot);
  const camiseta = await db.product.create({ data: { name: 'Camiseta', slug: `camiseta-${slot}`, price: 20, variants: { create: [{ size: 'M', color: '', stock: 2 }, { size: 'L', color: '', stock: 10 }] } } });
  const gorra = await db.product.create({ data: { name: 'Gorra', slug: `gorra-${slot}`, price: 10, variants: { create: [{ size: '', color: '', stock: 0 }] } } });
  const inactivo = await db.product.create({ data: { name: 'Viejo', slug: `viejo-${slot}`, price: 5, isActive: false, variants: { create: [{ size: '', color: '', stock: 0 }] } } });
  const order = (status: 'PAID' | 'PENDING' | 'CANCELLED' | 'REFUNDED' | 'SHIPPED', total: number, createdAt: Date, items: { productId: string; quantity: number; unitPrice: number }[]) =>
    db.shopOrder.create({ data: { buyerName: 'Ana', buyerEmail: 'ana@example.com', shippingAddress: 'C/ Sol 1', shippingCity: 'Valencia', shippingZip: '46001', totalAmount: total, status, createdAt, items: { create: items } } });
  await order('PAID', 40, daysAgo(1), [{ productId: camiseta.id, quantity: 2, unitPrice: 20 }]);
  await order('SHIPPED', 30, daysAgo(3), [{ productId: camiseta.id, quantity: 1, unitPrice: 20 }, { productId: gorra.id, quantity: 1, unitPrice: 10 }]);
  await order('PENDING', 999, daysAgo(1), [{ productId: gorra.id, quantity: 99, unitPrice: 10 }]);
  await order('CANCELLED', 888, daysAgo(2), [{ productId: gorra.id, quantity: 88, unitPrice: 10 }]);
  await order('REFUNDED', 777, daysAgo(2), [{ productId: gorra.id, quantity: 77, unitPrice: 10 }]);
  await order('PAID', 50, daysAgo(100), [{ productId: gorra.id, quantity: 5, unitPrice: 10 }]); // fuera de los 30 días y de la ventana de 90 de los más vendidos
  return { inactivo };
}

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
  route = await import('@/app/api/admin/shop-stats/route');
}, 180_000);
beforeEach(async () => {
  sessionRole = 'ADMIN';
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('getShopStats', () => {
  it('sin pedidos: ceros, 30 días vacíos y sin divisiones por cero', async () => {
    const s = await withTenantForTest('a', () => getShopStats(NOW));
    expect(s).toMatchObject({ revenue: 0, orders: 0, averageOrder: 0, toShip: 0 });
    expect(s.daily).toHaveLength(30);
    expect(s.daily.every((d) => d.revenue === 0 && d.orders === 0)).toBe(true);
    expect(s.topProducts).toEqual([]);
  });

  it('cuenta solo lo cobrado y no anulado ni devuelto (ni pendiente)', async () => {
    await seed('a');
    const s = await withTenantForTest('a', () => getShopStats(NOW));
    expect(s.revenue).toBe(120); // 40 + 30 + 50 (el pedido de hace 100 días cuenta en el total, no en los 30 días)
    expect(s.orders).toBe(3);
    expect(s.averageOrder).toBe(40);
    expect(s.toShip).toBe(2); // 2 PAID (el SHIPPED ya salió)
    expect(s.byStatus).toMatchObject({ PAID: 2, SHIPPED: 1, PENDING: 1, CANCELLED: 1, REFUNDED: 1 });
  });

  it('las ventas diarias suman solo los últimos 30 días y caen en su día de Madrid', async () => {
    await seed('a');
    const s = await withTenantForTest('a', () => getShopStats(NOW));
    expect(s.daily.reduce((n, d) => n + d.revenue, 0)).toBe(70);
    expect(s.daily.at(-1)?.date).toBe('2026-10-08');
    expect(s.daily.find((d) => d.date === '2026-10-07')).toMatchObject({ revenue: 40, orders: 1 });
    expect(s.daily.find((d) => d.date === '2026-10-05')).toMatchObject({ revenue: 30, orders: 1 });
  });

  it('los más vendidos ignoran pedidos anulados, devueltos y pendientes', async () => {
    await seed('a');
    const s = await withTenantForTest('a', () => getShopStats(NOW));
    expect(s.topProducts[0]).toMatchObject({ name: 'Camiseta', units: 3, revenue: 60 });
    expect(s.topProducts.find((p) => p.name === 'Gorra')).toMatchObject({ units: 1, revenue: 10 }); // no 99, 88 ni 77
  });

  it('poco stock: variantes de productos activos, de menos a más', async () => {
    await seed('a');
    const s = await withTenantForTest('a', () => getShopStats(NOW));
    expect(s.lowStock.map((v) => `${v.name}:${v.stock}`)).toEqual(['Gorra:0', 'Camiseta:2']);
  });

  it('cada cliente ve SU tienda', async () => {
    await seed('a');
    const b = await withTenantForTest('b', () => getShopStats(NOW));
    expect(b.orders).toBe(0);
    expect(b.recent).toEqual([]);
  });
});

describe('GET /api/admin/shop-stats', () => {
  it('solo ADMIN', async () => {
    sessionRole = 'TAQUILLA';
    expect((await withTenantForTest('a', () => route.GET())).status).toBe(401);
    sessionRole = null;
    expect((await withTenantForTest('a', () => route.GET())).status).toBe(401);
  });
  it('devuelve el resumen del cliente', async () => {
    await seed('a');
    const res = await withTenantForTest('a', () => route.GET());
    expect(res.status).toBe(200);
    expect((await res.json()).orders).toBe(3);
  });
});
