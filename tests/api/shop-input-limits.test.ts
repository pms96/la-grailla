import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getAndSetConfig, restoreConfig } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-shop-limits', role: 'ADMIN', email: 'admin-shop-limits@test.local' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: createProduct } = await import('@/app/api/admin/products/route');
const { PATCH: updateProduct } = await import('@/app/api/admin/products/[id]/route');
const { POST: createShopOrder } = await import('@/app/api/shop/orders/route');

const json = (method: string, body: unknown, ip = '198.51.100.77') =>
  new Request('http://localhost/api/x', { method, headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ acceptedTerms: true, ...(body as object) }) });

// AUDIT: el precio de un producto aceptaba valores negativos (z.coerce.number() sin mínimo) y la cantidad de una línea de pedido no
// tenía máximo. Un precio negativo da un pedido con total negativo o gratis; una cantidad enorme bloquea el stock de todos.
// Severidad: Alto (el dinero de un pedido se calcula con estos dos datos).
describe('Tienda — límites de precio y cantidad', () => {
  let originalGateway: string | null;
  let productId: string;
  const marker = `[TEST] Limites ${Date.now()}`;

  beforeAll(async () => {
    originalGateway = await getAndSetConfig('payment_gateway', 'mock');
    const product = await prisma.product.create({
      data: { name: marker, slug: `test-limites-${Date.now()}`, price: 20, isActive: true },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await restoreConfig('payment_gateway', originalGateway);
    await prisma.shopOrderItem.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { OR: [{ id: productId }, { name: { startsWith: '[TEST] Limites neg' } }] } });
  });

  it('crear un producto con precio negativo da 400 y no lo guarda', async () => {
    const res = await createProduct(json('POST', { name: '[TEST] Limites neg crear', price: -5 }));
    expect(res.status).toBe(400);
    expect(await prisma.product.count({ where: { name: '[TEST] Limites neg crear' } })).toBe(0);
  });

  it('actualizar un producto con precio negativo da 400 y no cambia el precio', async () => {
    const res = await updateProduct(json('PATCH', { price: -1 }), { params: Promise.resolve({ id: productId }) });
    expect(res.status).toBe(400);
    expect((await prisma.product.findUnique({ where: { id: productId } }))?.price).toBe(20);
  });

  it('un precio absurdo (más de 100.000) también se rechaza', async () => {
    const res = await createProduct(json('POST', { name: '[TEST] Limites neg enorme', price: 1e9 }));
    expect(res.status).toBe(400);
  });

  it('un precio normal y el 0 (producto gratis) siguen funcionando', async () => {
    const res = await updateProduct(json('PATCH', { price: 0 }), { params: Promise.resolve({ id: productId }) });
    expect(res.status).toBe(200);
    await updateProduct(json('PATCH', { price: 20 }), { params: Promise.resolve({ id: productId }) });
  });

  it('una línea de pedido con cantidad enorme se rechaza con 400', async () => {
    const res = await createShopOrder(
      json('POST', {
        buyerName: 'Luis',
        buyerEmail: 'luis-limites@example.com',
        shippingAddress: 'Calle Test 1',
        shippingCity: 'Madrid',
        shippingZip: '28001',
        items: [{ productId, quantity: 100000 }],
      })
    );
    expect(res.status).toBe(400);
  });
});
