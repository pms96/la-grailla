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

  // H-244: el código postal de 5 dígitos solo se validaba en el navegador y los textos de envío no tenían tope (el pedido de entradas sí limita nombre a 100): una petición directa
  // guardaba un CP o un texto cualquiera, que luego se imprime en el recibo y el albarán.
  describe('datos de envío (H-244)', () => {
    const base = { buyerName: 'Luis', buyerEmail: 'luis-envio@example.com', shippingAddress: 'Calle Test 1', shippingCity: 'Madrid', shippingZip: '28001' };
    // Una IP distinta por petición: el límite por IP (10/min) no debe falsear el resultado entre ejecuciones seguidas.
    let ipN = Math.floor(Math.random() * 100);
    const pedido = (over: Record<string, unknown>) => createShopOrder(json('POST', { ...base, items: [{ productId, quantity: 1 }], ...over }, `203.0.113.${100 + (ipN++ % 150)}`));
    // Los pedidos de prueba (con la validación vieja se creaban) no deben quedar en la BD de desarrollo: las líneas caen en cascada.
    afterAll(async () => {
      await prisma.shopOrder.deleteMany({ where: { buyerEmail: base.buyerEmail } });
    });

    it.each([
      ['un CP que no son 5 dígitos', { shippingZip: '28A01' }],
      ['un CP largo', { shippingZip: '280010' }],
      ['un CP corto', { shippingZip: '2800' }],
      ['un nombre de 101 caracteres', { buyerName: 'x'.repeat(101) }],
      ['una dirección de 301 caracteres', { shippingAddress: 'x'.repeat(301) }],
      ['una ciudad de 101 caracteres', { shippingCity: 'x'.repeat(101) }],
      ['un teléfono de 31 caracteres', { shippingPhone: '6'.repeat(31) }],
    ])('rechaza %s con 400', async (_label, over) => {
      const res = await pedido(over);
      expect(res.status).toBe(400);
    });

    it('un envío normal (CP con espacios alrededor, teléfono, textos largos pero dentro del tope) sigue funcionando', async () => {
      const res = await pedido({ shippingZip: ' 28001 ', shippingPhone: '+34 600 000 000', buyerName: 'x'.repeat(100), shippingAddress: 'y'.repeat(300) });
      expect(res.status).toBe(200);
    });
  });
});
