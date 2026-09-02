import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-shop-orders-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: getShopOrders } = await import('@/app/api/admin/shop-orders/route');

function req(query: string) {
  return new Request(`http://localhost${query}`);
}

// Fase 6 del plan de actuación (auditoría UX Pedidos & Gastos): buscador
// (q) y filtro de estado en Pedidos de Tienda, clonando el patrón ya
// probado en /api/admin/orders (Ventas).
describe('GET /api/admin/shop-orders — buscador y filtro de estado (Fase 6)', () => {
  let pedidoLuis: Awaited<ReturnType<typeof prisma.shopOrder.create>>;
  let pedidoAna: Awaited<ReturnType<typeof prisma.shopOrder.create>>;

  beforeAll(async () => {
    pedidoLuis = await prisma.shopOrder.create({
      data: {
        buyerName: '[TEST] Luis Fase6', buyerEmail: 'luis-fase6@example.com',
        shippingAddress: 'Calle Test 1', shippingCity: 'Madrid', shippingZip: '28001',
        totalAmount: 20, status: 'PAID',
      },
    });
    pedidoAna = await prisma.shopOrder.create({
      data: {
        buyerName: '[TEST] Ana Fase6', buyerEmail: 'ana-fase6@example.com',
        shippingAddress: 'Calle Test 2', shippingCity: 'Sevilla', shippingZip: '41001',
        totalAmount: 35, status: 'SHIPPED',
      },
    });
  });

  afterAll(async () => {
    await prisma.shopOrder.deleteMany({ where: { id: { in: [pedidoLuis.id, pedidoAna.id] } } });
  });

  it('sin filtros devuelve ambos pedidos', async () => {
    const res = await getShopOrders(req('/'));
    const data = await res.json();
    const ids = data.map((o: { id: string }) => o.id);
    expect(ids).toContain(pedidoLuis.id);
    expect(ids).toContain(pedidoAna.id);
  });

  it('filtra por nombre (q), sin distinguir mayúsculas', async () => {
    const res = await getShopOrders(req('/?q=luis+fase6'));
    const data = await res.json();
    const ids = data.map((o: { id: string }) => o.id);
    expect(ids).toContain(pedidoLuis.id);
    expect(ids).not.toContain(pedidoAna.id);
  });

  it('filtra por email (q)', async () => {
    const res = await getShopOrders(req('/?q=ana-fase6@example.com'));
    const data = await res.json();
    const ids = data.map((o: { id: string }) => o.id);
    expect(ids).toEqual([pedidoAna.id]);
  });

  it('filtra por estado', async () => {
    const res = await getShopOrders(req('/?status=SHIPPED'));
    const data = await res.json();
    const ids = data.map((o: { id: string }) => o.id);
    expect(ids).toContain(pedidoAna.id);
    expect(ids).not.toContain(pedidoLuis.id);
  });

  it('un status no válido se ignora en vez de romper la consulta', async () => {
    const res = await getShopOrders(req('/?status=no-es-un-estado'));
    expect(res.status).toBe(200);
    const data = await res.json();
    const ids = data.map((o: { id: string }) => o.id);
    expect(ids).toContain(pedidoLuis.id);
    expect(ids).toContain(pedidoAna.id);
  });

  it('rechaza a un usuario que no es ADMIN', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({ user: { id: 'u1', role: 'TAQUILLA' } } as never);
    const res = await getShopOrders(req('/'));
    expect(res.status).toBe(401);
  });
});
