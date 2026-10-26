import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { SECTION_CONFIG_KEYS } from '@/lib/content/sections';
import { enablePlatformEnv } from '../helpers/platform';
import { TEST_TENANT_IDS, disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Al cambiar o quitar el vídeo, el póster, el favicon o la imagen social del tema, el cartel de un evento o las fotos de un producto, el fichero
 * anterior se borra de Blob. Con garantías: solo lo que deja de usarse, solo del prefijo de ESTE cliente, nunca algo que otra cosa siga usando
 * (ni los logos ni los carteles de eventos con pedidos, que van incrustados por URL en emails y pases de wallet ya emitidos), y un fallo al borrar
 * no rompe el guardado. */

const blob = vi.hoisted(() => ({ del: vi.fn(async (_urls: string | string[]) => undefined) }));
vi.mock('@vercel/blob', () => ({ del: blob.del, put: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'u1', role: 'ADMIN', modules: null } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let env: ReturnType<typeof enablePlatformEnv>;

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
}, 180_000);
beforeEach(async () => {
  blob.del.mockClear();
  blob.del.mockImplementation(async () => undefined);
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

const HOST = 'https://abc123.public.blob.vercel-storage.com';
const mine = (path: string) => `${HOST}/${TEST_TENANT_IDS.a}/${path}`;
const theirs = (path: string) => `${HOST}/${TEST_TENANT_IDS.b}/${path}`;
const MODULES = ['nucleo', 'entradas', 'tienda'] as never;

const call = <T>(fn: () => Promise<T>) => withTenantForTest('a', fn, { modules: MODULES });
const req = (method: string, body?: unknown) => new Request('http://a.cliente.test/api/admin/x', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const deleted = () => blob.del.mock.calls.flatMap((c) => (Array.isArray(c[0]) ? c[0] : [c[0]])).sort();

const theme = (assets: Record<string, string> = {}) => ({
  v: 1,
  template: 'editorial',
  mode: 'light',
  radius: 'suave',
  colors: { primary: '#1d4ed8', accent: '#f59e0b' },
  fonts: { display: 'inter', body: 'inter' },
  assets,
  brand: { name: 'Sala', tagline: '', description: '', legalName: '', sticker: '' },
});
const putTheme = async (assets: Record<string, string> = {}) => {
  const { PUT } = await import('@/app/api/admin/theme/route');
  return call(() => PUT(req('PUT', theme(assets))));
};
const saveEvent = (slug: string, imageUrl: string | null) =>
  tenantClient('a').event.create({ data: { name: slug, slug, venue: 'Sala', city: 'Madrid', date: new Date('2030-01-01T20:00:00Z'), status: 'PUBLISHED', imageUrl } });

describe('tema: vídeo, póster, favicon e imagen social', () => {
  it('la primera vez no hay nada que borrar; al sustituir el póster se borra el anterior', async () => {
    expect((await putTheme({ heroPoster: mine('brand/poster-1.jpg') })).status).toBe(200);
    expect(blob.del).not.toHaveBeenCalled();
    expect((await putTheme({ heroPoster: mine('brand/poster-2.jpg') })).status).toBe(200);
    expect(deleted()).toEqual([mine('brand/poster-1.jpg')]);
  });

  it('un recurso que sigue en el tema no se toca; solo los que se quitan o se sustituyen', async () => {
    await putTheme({ logoOnDark: mine('brand/dark.png'), favicon: mine('brand/fav.png'), heroVideo: mine('brand/hero/clip.mp4') });
    blob.del.mockClear();
    await putTheme({ logoOnDark: mine('brand/dark.png'), favicon: mine('brand/fav-nuevo.png') });
    expect(deleted()).toEqual([mine('brand/fav.png'), mine('brand/hero/clip.mp4')].sort());
  });

  it('los LOGOS no se borran nunca: los emails enviados y el pase de Google Wallet los llevan por URL', async () => {
    await putTheme({ logoOnDark: mine('brand/dark-1.png'), logoOnLight: mine('brand/light-1.png') });
    await putTheme({ logoOnDark: mine('brand/dark-2.png'), logoOnLight: mine('brand/light-2.png') });
    expect(blob.del).not.toHaveBeenCalled();
    const { DELETE } = await import('@/app/api/admin/theme/route');
    await call(() => DELETE()); // ni siquiera al volver a la apariencia por defecto
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('guardar el mismo tema otra vez no borra nada', async () => {
    await putTheme({ favicon: mine('brand/fav.png') });
    blob.del.mockClear();
    await putTheme({ favicon: mine('brand/fav.png') });
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('un fichero de OTRO cliente que figurase en el tema guardado nunca se borra', async () => {
    const stray = theirs('brand/ajeno.png');
    await tenantClient('a').appConfig.create({ data: { key: 'site_theme', value: JSON.stringify(theme({ favicon: stray })), label: 'x', group: 'brand' } });
    await putTheme({});
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('si el fichero sigue en uso en otro sitio (el cartel de un evento), no se borra', async () => {
    const shared = mine('brand/compartida.png');
    await putTheme({ favicon: shared });
    await saveEvent('con-cartel', shared);
    blob.del.mockClear();
    await putTheme({});
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('si el mismo fichero queda en otro recurso del tema, tampoco se borra', async () => {
    const shared = mine('brand/mismo.png');
    await putTheme({ favicon: shared, ogImage: shared });
    blob.del.mockClear();
    await putTheme({ ogImage: shared });
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('volver a la apariencia por defecto borra los recursos del tema (menos los logos)', async () => {
    await putTheme({ logoOnDark: mine('brand/dark.png'), favicon: mine('brand/fav.png'), heroPoster: mine('brand/poster.jpg') });
    blob.del.mockClear();
    const { DELETE } = await import('@/app/api/admin/theme/route');
    expect((await call(() => DELETE())).status).toBe(200);
    expect(deleted()).toEqual([mine('brand/fav.png'), mine('brand/poster.jpg')].sort());
  });

  it('un fallo de Blob al borrar no rompe el guardado', async () => {
    await putTheme({ favicon: mine('brand/fav-1.png') });
    blob.del.mockRejectedValueOnce(new Error('Blob caído'));
    const res = await putTheme({ favicon: mine('brand/fav-2.png') });
    expect(res.status).toBe(200);
    const stored = await tenantClient('a').appConfig.findUnique({ where: { key: 'site_theme' } });
    expect(JSON.parse(stored!.value).assets.favicon).toBe(mine('brand/fav-2.png'));
  });
});

describe('eventos', () => {
  it('al cambiar el cartel se borra el anterior; al borrar el evento, el cartel', async () => {
    const ev = await saveEvent('concierto', mine('events/viejo.jpg'));
    const { PUT, DELETE } = await import('@/app/api/admin/events/[id]/route');
    expect((await call(() => PUT(req('PUT', { imageUrl: mine('events/nuevo.jpg') }), { params: Promise.resolve({ id: ev.id }) }))).status).toBe(200);
    expect(deleted()).toEqual([mine('events/viejo.jpg')]);

    blob.del.mockClear();
    expect((await call(() => DELETE(req('DELETE'), { params: Promise.resolve({ id: ev.id }) }))).status).toBe(200);
    expect(deleted()).toEqual([mine('events/nuevo.jpg')]);
  });

  it('editar otros campos (sin tocar el cartel) no borra nada', async () => {
    const ev = await saveEvent('concierto', mine('events/cartel.jpg'));
    const { PUT } = await import('@/app/api/admin/events/[id]/route');
    expect((await call(() => PUT(req('PUT', { name: 'Otro nombre' }), { params: Promise.resolve({ id: ev.id }) }))).status).toBe(200);
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('con pedidos hechos el cartel anterior NO se borra al sustituirlo (emails enviados y pases de Google Wallet lo llevan por URL)', async () => {
    const ev = await saveEvent('vendido', mine('events/viejo.jpg'));
    await tenantClient('a').order.create({ data: { eventId: ev.id, buyerName: 'Ana', buyerLastName: 'Pérez', buyerEmail: 'ana@example.com', totalAmount: 15 } });
    const { PUT } = await import('@/app/api/admin/events/[id]/route');
    expect((await call(() => PUT(req('PUT', { imageUrl: mine('events/nuevo.jpg') }), { params: Promise.resolve({ id: ev.id }) }))).status).toBe(200);
    expect(blob.del).not.toHaveBeenCalled();
    const stored = await tenantClient('a').event.findUnique({ where: { id: ev.id } });
    expect(stored?.imageUrl).toBe(mine('events/nuevo.jpg')); // el cambio sí se guarda
  });

  it('si dos eventos comparten el cartel, cambiarlo en uno no lo borra', async () => {
    const shared = mine('events/compartido.jpg');
    const a = await saveEvent('uno', shared);
    await saveEvent('dos', shared);
    const { PUT } = await import('@/app/api/admin/events/[id]/route');
    await call(() => PUT(req('PUT', { imageUrl: mine('events/otro.jpg') }), { params: Promise.resolve({ id: a.id }) }));
    expect(blob.del).not.toHaveBeenCalled();
  });
});

describe('productos', () => {
  it('al cambiar las fotos se borran solo las que sobran; desactivar el producto no borra nada', async () => {
    const p = await tenantClient('a').product.create({
      data: { name: 'Taza', slug: 'taza', price: 9, imageUrl: mine('shop/a.jpg'), images: [mine('shop/a.jpg'), mine('shop/b.jpg'), mine('shop/c.jpg')] },
    });
    const { PATCH, DELETE } = await import('@/app/api/admin/products/[id]/route');
    const res = await call(() => PATCH(req('PATCH', { imageUrl: mine('shop/a.jpg'), images: [mine('shop/a.jpg'), mine('shop/c.jpg')] }), { params: Promise.resolve({ id: p.id }) }));
    expect(res.status).toBe(200);
    expect(deleted()).toEqual([mine('shop/b.jpg')]);

    blob.del.mockClear();
    expect((await call(() => DELETE(req('DELETE'), { params: Promise.resolve({ id: p.id }) }))).status).toBe(200);
    expect(blob.del).not.toHaveBeenCalled(); // «borrar» un producto solo lo desactiva: sus fotos siguen siendo suyas
  });
});

describe('otros sitios donde puede haber una URL de Blob', () => {
  it('si un PDF de pedido usa el mismo fichero, la foto del producto no se borra aunque se quite', async () => {
    const shared = mine('shop/compartida.jpg');
    const p = await tenantClient('a').product.create({ data: { name: 'Taza', slug: 'taza', price: 9, imageUrl: shared, images: [shared] } });
    const ev = await saveEvent('con-pdf', null);
    await tenantClient('a').order.create({ data: { eventId: ev.id, buyerName: 'Ana', buyerLastName: 'Pérez', buyerEmail: 'ana@example.com', totalAmount: 9, pdfUrl: shared } });
    const { PATCH } = await import('@/app/api/admin/products/[id]/route');
    await call(() => PATCH(req('PATCH', { imageUrl: null, images: [] }), { params: Promise.resolve({ id: p.id }) }));
    expect(blob.del).not.toHaveBeenCalled();
  });
});

describe('secciones de contenido', () => {
  const section = (...images: string[]) => JSON.stringify({ title: 'Proyectos', intro: '', items: images.map((imageUrl, i) => ({ title: `P${i}`, text: '', meta: '', imageUrl, href: '' })) });
  const putSections = async (configs: { key: string; value: string }[]) => {
    const { PUT } = await import('@/app/api/admin/config/route');
    return call(() => PUT(req('PUT', { configs })));
  };

  it('la imagen de un proyecto quitado o sustituido se borra; la que se queda, no', async () => {
    const key = SECTION_CONFIG_KEYS.proyectos;
    await putSections([{ key, value: section(mine('sections/a.jpg'), mine('sections/b.jpg')) }]);
    expect(blob.del).not.toHaveBeenCalled();
    expect((await putSections([{ key, value: section(mine('sections/a.jpg'), mine('sections/c.jpg')) }])).status).toBe(200);
    expect(deleted()).toEqual([mine('sections/b.jpg')]);

    blob.del.mockClear();
    await putSections([{ key, value: '' }]); // vaciar la sección libera todas sus imágenes
    expect(deleted()).toEqual([mine('sections/a.jpg'), mine('sections/c.jpg')].sort());
  });

  it('una clave que no es una sección no dispara ningún borrado', async () => {
    await putSections([{ key: 'footer_tagline', value: 'Hola' }]);
    expect(blob.del).not.toHaveBeenCalled();
  });
});
