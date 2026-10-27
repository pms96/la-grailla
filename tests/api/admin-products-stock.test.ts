import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { reserveShopStock, syncProductVariants } from '@/lib/product-stock';
import { buildVariantsPayload } from '@/lib/product-variants-payload';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-products-stock', role: 'ADMIN', email: 'admin-products-stock@test.local' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { PATCH } = await import('@/app/api/admin/products/[id]/route');

const patch = (id: string, body: unknown) =>
  PATCH(
    new Request('http://localhost/api/admin/products/x', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  );

// AUDIT P0-01 / TI-01: guardar un producto pisaba el stock de todas sus variantes con el valor que cargó la pantalla (sobreventa).
describe('PATCH /api/admin/products/[id] — stock de variantes', () => {
  let productId: string;
  const stockOf = async (size: string) =>
    (await prisma.productVariant.findFirst({ where: { productId, size, color: 'Negro' } }))?.stock;
  // Una venta de la tienda entre el momento en que el admin abre el diálogo y el momento en que guarda.
  const sell = async (size: string, quantity: number) => {
    const err = await prisma.$transaction((tx) => reserveShopStock(tx, [{ productId, size, color: 'Negro', quantity }]));
    expect(err).toBeNull();
  };

  beforeEach(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const product = await prisma.product.create({
      data: { name: `[TEST] Stock ${suffix}`, slug: `test-stock-${suffix}`, price: 20, sizes: 'M,L', colors: 'Negro', isActive: true },
    });
    productId = product.id;
    await prisma.$transaction((tx) =>
      syncProductVariants(tx, product.id, product.sizes, product.colors, [
        { size: 'M', color: 'Negro', stock: 5 },
        { size: 'L', color: 'Negro', stock: 3 },
      ])
    );
  });

  afterEach(async () => {
    await prisma.product.deleteMany({ where: { id: productId } });
  });

  it('cambiar el precio sin tocar el stock tras una venta concurrente no devuelve las unidades vendidas', async () => {
    // El admin abrió el diálogo con M:5, L:3 (originalStock) y solo cambia el precio.
    const variants = buildVariantsPayload({
      editing: true, sizes: 'M,L', colors: 'Negro', sizesChanged: false, colorsChanged: false,
      originalStock: { 'M|Negro': 5, 'L|Negro': 3 }, stockByKey: { 'M|Negro': 5, 'L|Negro': 3 }, stockTouched: false,
    });
    expect(variants).toBeUndefined();
    await sell('M', 3); // mientras tanto se venden 3 camisetas M
    const res = await patch(productId, { price: 25, ...(variants ? { variants } : {}) });
    expect(res.status).toBe(200);
    expect(Number((await prisma.product.findUnique({ where: { id: productId } }))?.price)).toBe(25);
    expect(await stockOf('M')).toBe(2);
    expect(await stockOf('L')).toBe(3);
  });

  it('un cambio de stock con expectedStock correcto se aplica', async () => {
    const res = await patch(productId, { variants: [{ size: 'M', color: 'Negro', stock: 10, expectedStock: 5 }] });
    expect(res.status).toBe(200);
    expect(await stockOf('M')).toBe(10);
    expect(await stockOf('L')).toBe(3);
  });

  it('si el stock cambió desde que se cargó (venta), responde 409 con la variante y el stock actual y no guarda nada', async () => {
    await sell('M', 3); // stock real 2; el admin veía 5
    const res = await patch(productId, {
      price: 99,
      variants: [
        { size: 'M', color: 'Negro', stock: 10, expectedStock: 5 },
        { size: 'L', color: 'Negro', stock: 7, expectedStock: 3 },
      ],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('stock_conflict');
    expect(body.error).toContain('M · Negro');
    expect(body.error).toContain('ahora hay 2');
    expect(body.error).toContain('tú veías 5');
    expect(body.conflicts).toEqual([{ size: 'M', color: 'Negro', expected: 5, current: 2 }]);
    // Transacción deshecha: ni el stock (tampoco el de L, que sí coincidía) ni el precio cambian.
    expect(await stockOf('M')).toBe(2);
    expect(await stockOf('L')).toBe(3);
    expect(Number((await prisma.product.findUnique({ where: { id: productId } }))?.price)).toBe(20);
    // Reintento con el stock actual como referencia: se aplica.
    const retry = await patch(productId, { variants: [{ size: 'M', color: 'Negro', stock: 10, expectedStock: 2 }] });
    expect(retry.status).toBe(200);
    expect(await stockOf('M')).toBe(10);
  });

  it('añadir una talla nueva la crea con su stock sin tocar el de las demás, aunque hubiera ventas', async () => {
    await sell('L', 1); // L: 2
    const variants = buildVariantsPayload({
      editing: true, sizes: 'M,L,XL', colors: 'Negro', sizesChanged: true, colorsChanged: false,
      originalStock: { 'M|Negro': 5, 'L|Negro': 3 }, stockByKey: { 'M|Negro': 5, 'L|Negro': 3, 'XL|Negro': 4 }, stockTouched: true,
    });
    const res = await patch(productId, { sizes: 'M,L,XL', variants });
    expect(res.status).toBe(200);
    expect(await stockOf('XL')).toBe(4);
    expect(await stockOf('M')).toBe(5);
    expect(await stockOf('L')).toBe(2);
  });

  it('quitar una talla borra solo su variante y conserva el stock de las demás', async () => {
    await sell('M', 1); // M: 4
    const variants = buildVariantsPayload({
      editing: true, sizes: 'M', colors: 'Negro', sizesChanged: true, colorsChanged: false,
      originalStock: { 'M|Negro': 5, 'L|Negro': 3 }, stockByKey: { 'M|Negro': 5 }, stockTouched: false,
    });
    const res = await patch(productId, { sizes: 'M', variants });
    expect(res.status).toBe(200);
    expect(await stockOf('L')).toBeUndefined();
    expect(await stockOf('M')).toBe(4);
  });

  it('una variante que ya no existe y el admin veía responde 409 en vez de recrearla', async () => {
    await prisma.productVariant.deleteMany({ where: { productId, size: 'L' } });
    const res = await patch(productId, { variants: [{ size: 'L', color: 'Negro', stock: 9, expectedStock: 3 }] });
    expect(res.status).toBe(409);
    expect((await res.json()).conflicts).toEqual([{ size: 'L', color: 'Negro', expected: 3, current: null }]);
    expect(await stockOf('L')).toBeUndefined();
  });

  it('sin expectedStock el valor sigue siendo absoluto (compatibilidad con llamadores antiguos)', async () => {
    const res = await patch(productId, { variants: [{ size: 'M', color: 'Negro', stock: 8 }] });
    expect(res.status).toBe(200);
    expect(await stockOf('M')).toBe(8);
  });
});
