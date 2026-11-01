import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { syncProductVariants } from '@/lib/product-stock';
import { getAndSetConfig, restoreConfig } from '../helpers/fixtures';

// Con la pasarela `mock` el pedido nace pagado y se manda el correo de confirmación: aquí no sale nada a ningún servidor de correo.
vi.mock('@/lib/mailer', async (orig) => ({
  ...(await orig<typeof import('@/lib/mailer')>()),
  sendMail: async () => ({ success: true, transport: 'smtp' as const }),
}));

const { POST: createShopOrder } = await import('@/app/api/shop/orders/route');

/* H-132: el carrito (localStorage) guarda el precio del día en que se añadió el producto y el checkout enseña «Pagar 25,00 €», pero el servidor cobraba el
 * `Product.price` actual sin compararlo: si el precio pasaba de 25 a 30 € entre medias, el comprador pagaba 30 € creyendo pagar 25 €. Ahora el cliente manda el
 * total que está viendo y, si no coincide, el servidor responde 409 con las cifras nuevas y NO crea pedido ni toca el stock. */

let ipSeq = 0;
const ip = () => `203.0.113.${(ipSeq = (ipSeq % 250) + 1)}`;
const post = (body: unknown) =>
  new Request('http://localhost/api/shop/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify(body) });

const KEYS = ['payment_gateway', 'legal_terms_tienda', 'privacy_policy', 'vat_rate_tienda'] as const;

describe('H-132: el precio que se cobra es el que se vio', () => {
  const originals: Record<string, string | null> = {};
  let productId: string;

  beforeAll(async () => {
    for (const k of KEYS) originals[k] = await getAndSetConfig(k, k === 'payment_gateway' ? 'mock' : '');
  });
  afterAll(async () => {
    for (const k of KEYS) await restoreConfig(k, originals[k]);
  });

  beforeEach(async () => {
    const suffix = `price-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const p = await prisma.product.create({ data: { name: `[TEST] Gorra ${suffix}`, slug: `test-gorra-${suffix}`, price: 25, sizes: 'M', colors: 'Negro', isActive: true } });
    productId = p.id;
    await prisma.$transaction(async (tx) => {
      await syncProductVariants(tx, p.id, p.sizes, p.colors, [{ size: 'M', color: 'Negro', stock: 5 }]);
    });
  });
  afterEach(async () => {
    await prisma.shopOrderItem.deleteMany({ where: { productId } });
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId } } } });
    await prisma.product.delete({ where: { id: productId } }).catch(() => {});
  });

  const body = (over: Record<string, unknown> = {}) => ({
    buyerName: 'Luis',
    buyerEmail: `luis-${Math.random().toString(36).slice(2, 7)}@example.com`,
    shippingAddress: 'Calle 1',
    shippingCity: 'Madrid',
    shippingZip: '28001',
    acceptedTerms: true,
    items: [{ productId, quantity: 2, size: 'M', color: 'Negro' }],
    ...over,
  });
  const stock = async () => (await prisma.productVariant.findFirstOrThrow({ where: { productId } })).stock;
  const pedidos = () => prisma.shopOrder.count({ where: { items: { some: { productId } } } });

  it('con el total esperado correcto crea el pedido', async () => {
    const res = await createShopOrder(post(body({ expectedTotalCents: 5000 })));
    expect(res.status).toBe(200);
    expect(await pedidos()).toBe(1);
  });

  it('si el precio subió entre medias: 409 con el total y los precios nuevos, sin pedido y sin tocar el stock', async () => {
    await prisma.product.update({ where: { id: productId }, data: { price: 30 } });
    const res = await createShopOrder(post(body({ expectedTotalCents: 5000 })));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('price_changed');
    expect(data.totalAmount).toBe(60);
    expect(data.prices).toEqual([{ productId, unitPrice: 30 }]);
    expect(data.error).toContain('60,00');
    expect(await pedidos()).toBe(0);
    expect(await stock()).toBe(5);
  });

  it('también si bajó: el comprador ve la cifra nueva antes de pagar', async () => {
    await prisma.product.update({ where: { id: productId }, data: { price: 20 } });
    const res = await createShopOrder(post(body({ expectedTotalCents: 5000 })));
    expect(res.status).toBe(409);
    expect((await res.json()).totalAmount).toBe(40);
    expect(await pedidos()).toBe(0);
  });

  it('un producto desactivado entre medias también cambia el total: 409, no un pedido más barato en silencio', async () => {
    const other = await prisma.product.create({ data: { name: `[TEST] Otro ${Date.now()}`, slug: `test-otro-${Date.now()}`, price: 10, isActive: true } });
    try {
      await prisma.product.update({ where: { id: other.id }, data: { isActive: false } });
      const res = await createShopOrder(post(body({ expectedTotalCents: 5000 + 1000, items: [{ productId, quantity: 2, size: 'M', color: 'Negro' }, { productId: other.id, quantity: 1 }] })));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('price_changed');
    } finally {
      await prisma.product.delete({ where: { id: other.id } }).catch(() => {});
    }
  });

  it('sin expectedTotalCents (cliente antiguo o API directa) se sigue cobrando el precio vigente', async () => {
    await prisma.product.update({ where: { id: productId }, data: { price: 30 } });
    const res = await createShopOrder(post(body()));
    expect(res.status).toBe(200);
    const order = await prisma.shopOrder.findFirstOrThrow({ where: { items: { some: { productId } } } });
    expect(order.totalAmount).toBe(60);
  });

  it('un total esperado negativo o no entero es una petición mal formada (400)', async () => {
    expect((await createShopOrder(post(body({ expectedTotalCents: -1 })))).status).toBe(400);
    expect((await createShopOrder(post(body({ expectedTotalCents: 12.5 })))).status).toBe(400);
  });
});
