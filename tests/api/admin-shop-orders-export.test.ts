import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-shop-export', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: exportOrders } = await import('@/app/api/admin/shop-orders/export/route');

const get = (query = '') => exportOrders(new Request(`http://localhost/api/admin/shop-orders/export${query}`));

// AUDIT P0-09 / TI-04: el panel de pedidos no mostraba talla/color/teléfono y no había exportación.
describe('GET /api/admin/shop-orders/export', () => {
  let productId: string;
  let paidId: string;
  let shippedId: string;
  const tag = `[TEST] Export ${Date.now()}`;

  beforeAll(async () => {
    const product = await prisma.product.create({ data: { name: `${tag} Camiseta`, slug: `test-export-${Date.now()}`, price: 20, isActive: true } });
    productId = product.id;
    const paid = await prisma.shopOrder.create({
      data: {
        buyerName: `${tag} Ana`, buyerEmail: 'ana-export@example.com', shippingAddress: 'Calle Mayor 1', shippingCity: 'Madrid',
        shippingZip: '28001', shippingPhone: '600123456', totalAmount: 40, status: 'PAID',
        items: { create: [{ productId, quantity: 2, unitPrice: 20, size: 'M', color: 'Negro' }] },
      },
    });
    paidId = paid.id;
    const shipped = await prisma.shopOrder.create({
      data: {
        buyerName: `${tag} Luis`, buyerEmail: 'luis-export@example.com', shippingAddress: 'Calle Sol 2', shippingCity: 'Sevilla',
        shippingZip: '41001', totalAmount: 20, status: 'SHIPPED',
        items: { create: [{ productId, quantity: 1, unitPrice: 20, size: 'L', color: 'Blanco' }] },
      },
    });
    shippedId = shipped.id;
  });

  afterAll(async () => {
    await prisma.shopOrder.deleteMany({ where: { id: { in: [paidId, shippedId] } } });
    await prisma.product.deleteMany({ where: { id: productId } });
  });

  it('devuelve un CSV con BOM, ;, talla, color, teléfono y dirección', async () => {
    const res = await get(`?q=${encodeURIComponent(tag)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(/filename="pedidos-tienda-\d{4}-\d{2}-\d{2}\.csv"/);
    // Response.text() descarta el BOM al decodificar: se comprueba en los bytes.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    const ana = csv.split('\r\n').find((l) => l.includes('ana-export@example.com'))!;
    expect(ana).toContain(';Pagado;');
    expect(ana).toContain(';600123456;');
    expect(ana).toContain(';Calle Mayor 1;28001;Madrid;');
    expect(ana).toContain('Camiseta;M;Negro;2;20,00;40,00;40,00;');
  });

  it('respeta los filtros del listado (estado)', async () => {
    const csv = await (await get(`?q=${encodeURIComponent(tag)}&status=SHIPPED`)).text();
    expect(csv).toContain('luis-export@example.com');
    expect(csv).not.toContain('ana-export@example.com');
  });

  it('si hay más pedidos que el tope responde 413 con mensaje y no trunca', async () => {
    const spy = vi.spyOn(prisma.shopOrder, 'count').mockResolvedValueOnce(6000);
    const res = await get();
    spy.mockRestore();
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('6000');
  });

  it('sin sesión de administrador responde 401', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
  });
});
