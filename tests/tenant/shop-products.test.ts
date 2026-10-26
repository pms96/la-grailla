import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Lectura de productos para la tienda renderizada en servidor (plantilla «drop»): solo activos, con sus variantes, sin mezclar clientes, y la
 * ficha `/tienda/<slug>` respeta el módulo Tienda. */

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => null) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

let env: ReturnType<typeof enablePlatformEnv>;

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
}, 180_000);
beforeEach(async () => {
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

const create = (slot: 'a' | 'b', slug: string, over: Record<string, unknown> = {}) =>
  tenantClient(slot).product.create({
    data: { name: `Producto ${slug}`, slug, price: 19.5, isActive: true, sizes: 'S, M', colors: 'Negro', ...over },
  });

const asA = <T>(fn: () => Promise<T>, modules?: string[]) => withTenantForTest('a', fn, modules ? { modules: modules as never } : {});

describe('getShopProducts / getShopProduct', () => {
  it('solo los productos activos, con su stock por variante y el precio como número', async () => {
    await create('a', 'camiseta', { variants: { create: [{ size: 'S', color: 'Negro', stock: 3 }, { size: 'M', color: 'Negro', stock: 0 }] } });
    await create('a', 'oculto', { isActive: false });
    const { getShopProducts } = await import('@/lib/shop/products');
    const list = await asA(() => getShopProducts());
    expect(list.map((p) => p.slug)).toEqual(['camiseta']);
    const p = list[0]!;
    expect(typeof p.price).toBe('number');
    expect(p.price).toBe(19.5);
    expect(p.variants).toEqual([
      { size: 'M', color: 'Negro', stock: 0 },
      { size: 'S', color: 'Negro', stock: 3 },
    ]);
    expect(p.inStock).toBe(true);
    expect(p.path).toBe('/tienda/camiseta');
  });

  it('la ficha se abre por slug o por id; uno desactivado, inexistente o vacío no existe', async () => {
    const visible = await create('a', 'taza');
    const oculto = await create('a', 'oculta', { isActive: false });
    const { getShopProduct } = await import('@/lib/shop/products');
    expect((await asA(() => getShopProduct('taza')))?.id).toBe(visible.id);
    expect((await asA(() => getShopProduct(visible.id)))?.slug).toBe('taza');
    expect(await asA(() => getShopProduct('oculta'))).toBeNull();
    expect(await asA(() => getShopProduct(oculto.id))).toBeNull();
    expect(await asA(() => getShopProduct('no-existe'))).toBeNull();
    expect(await asA(() => getShopProduct('  '))).toBeNull();
  });

  it('un producto con un slug reservado (checkout, confirmacion) no se abre por él, pero sí por su id', async () => {
    const p = await create('a', 'checkout');
    const { getShopProduct, getShopProducts } = await import('@/lib/shop/products');
    expect(await asA(() => getShopProduct('checkout'))).toBeNull();
    const byId = await asA(() => getShopProduct(p.id));
    expect(byId?.path).toBe(`/tienda/${p.id}`);
    expect((await asA(() => getShopProducts()))[0]?.path).toBe(`/tienda/${p.id}`); // el listado enlaza por id
  });

  it('no mezcla clientes: el producto de B no se ve desde A', async () => {
    await create('b', 'solo-de-b');
    await create('a', 'solo-de-a');
    const { getShopProduct, getShopProducts } = await import('@/lib/shop/products');
    expect((await asA(() => getShopProducts())).map((p) => p.slug)).toEqual(['solo-de-a']);
    expect(await asA(() => getShopProduct('solo-de-b'))).toBeNull();
  });
});

describe('sitemap.xml y las fichas de producto', () => {
  const dropTheme = JSON.stringify({ v: 1, template: 'drop', colors: { primary: '#7c3aed', accent: '#f59e0b' }, brand: { name: 'Merch' } });
  const urls = async (modules: string[]) => {
    const { default: sitemap } = await import('@/app/sitemap');
    return (await asA(() => sitemap(), modules)).map((e) => e.url);
  };
  const isProduct = (u: string) => /\/tienda\/[^/]+$/.test(u);

  it('con la plantilla «drop» y el módulo Tienda se publican las fichas de los productos activos (y solo esas)', async () => {
    await tenantClient('a').appConfig.create({ data: { key: 'site_theme', value: dropTheme, label: 'x', group: 'brand' } });
    await create('a', 'camiseta');
    await create('a', 'oculta', { isActive: false });
    const list = await urls(['nucleo', 'tienda']);
    expect(list.filter(isProduct).map((u) => u.split('/').pop())).toEqual(['camiseta']);
    expect(list.some((u) => u.endsWith('/tienda'))).toBe(true);
  });

  it('con otra plantilla no se anuncian fichas que el sitio no enseña; sin el módulo Tienda tampoco, aunque sea «drop»', async () => {
    await create('a', 'camiseta');
    expect((await urls(['nucleo', 'tienda'])).some(isProduct)).toBe(false); // sin tema: plantilla neutra
    await tenantClient('a').appConfig.create({ data: { key: 'site_theme', value: dropTheme, label: 'x', group: 'brand' } });
    expect((await urls(['nucleo', 'entradas'])).some(isProduct)).toBe(false);
  });
});

describe('página de producto /tienda/[slug]', () => {
  it('con el módulo Tienda y un producto activo, la página responde; sin producto o sin el módulo, 404', async () => {
    await create('a', 'camiseta');
    const { default: ProductoPage } = await import('@/app/(public)/tienda/[slug]/page');
    const ok = await asA(() => ProductoPage({ params: Promise.resolve({ slug: 'camiseta' }) }), ['nucleo', 'tienda']);
    expect(ok).toBeTruthy();
    await expect(asA(() => ProductoPage({ params: Promise.resolve({ slug: 'no-existe' }) }), ['nucleo', 'tienda'])).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    // Sin Tienda el producto existe en la BD, pero la ficha no se sirve.
    await expect(asA(() => ProductoPage({ params: Promise.resolve({ slug: 'camiseta' }) }), ['nucleo', 'entradas'])).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});
