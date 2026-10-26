import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* SEO de las páginas públicas por cliente: URL canónica del dominio de ESE cliente, `noindex` de lo no publicado y datos estructurados del
 * evento. La base sale del dominio principal del cliente (nunca de las cabeceras de la petición). */

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => null) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
// `cache` solo existe en la build de React que usa Next para componentes de servidor; aquí basta con que ejecute la función.
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), cache: <T,>(fn: T) => fn }));

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

// El host de pruebas por defecto (`*.cliente.test`) cuenta como host de desarrollo y se sirve en http: aquí se usa el dominio real del cliente.
const asA = <T>(fn: () => T) => withTenantForTest('a', fn, { host: 'a.cliente.es', modules: ['nucleo', 'entradas', 'tienda', 'sponsors'] as never });
const asB = <T>(fn: () => T) => withTenantForTest('b', fn, { host: 'b.cliente.es', modules: ['nucleo', 'entradas', 'tienda', 'sponsors'] as never });

const createEvent = (slot: 'a' | 'b', slug: string, over: Record<string, unknown> = {}) =>
  tenantClient(slot).event.create({
    data: {
      name: `Evento ${slug}`,
      slug,
      venue: 'Sala',
      city: 'Madrid',
      date: new Date('2030-05-01T20:00:00Z'),
      status: 'PUBLISHED',
      ticketTypes: { create: [{ name: 'General', price: 12, maxQuantity: 50 }] },
      ...over,
    },
  });

/** Busca los <script type="application/ld+json"> en el árbol de React que devuelve una página (sin renderizarlo). */
function ldScripts(node: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const el = n as { type?: unknown; props?: { type?: string; dangerouslySetInnerHTML?: { __html: string }; children?: unknown } };
    if (el.type === 'script' && el.props?.type === 'application/ld+json' && el.props.dangerouslySetInnerHTML) {
      found.push(JSON.parse(el.props.dangerouslySetInnerHTML.__html));
    }
    walk(el.props?.children);
  };
  walk(node);
  return found;
}

/** Todos los textos sueltos del árbol de React que devuelve una página (sin renderizarlo: la ficha lleva componentes de cliente). */
function texts(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === 'string') return void out.push(n);
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') walk((n as { props?: { children?: unknown } }).props?.children);
  };
  walk(node);
  return out;
}

describe('URL canónica por cliente', () => {
  it('las páginas públicas apuntan al dominio principal de su cliente, sin parámetros', async () => {
    const eventos = await import('@/app/(public)/eventos/page');
    const tienda = await import('@/app/(public)/tienda/page');
    const sponsors = await import('@/app/(public)/sponsors/page');
    const home = await import('@/app/(public)/page');
    const aviso = await import('@/app/(public)/legal/aviso-legal/page');
    const canon = async (fn: () => unknown, run = asA) => ((await run(() => Promise.resolve(fn()))) as { alternates?: { canonical?: string } }).alternates?.canonical;

    expect(await canon(() => home.generateMetadata())).toBe('https://a.cliente.es/');
    expect(await canon(() => eventos.generateMetadata())).toBe('https://a.cliente.es/eventos');
    expect(await canon(() => tienda.generateMetadata())).toBe('https://a.cliente.es/tienda');
    expect(await canon(() => sponsors.generateMetadata())).toBe('https://a.cliente.es/sponsors');
    expect(await canon(() => aviso.generateMetadata())).toBe('https://a.cliente.es/legal/aviso-legal');
    // Otro cliente, otro dominio: nada se mezcla.
    expect(await canon(() => eventos.generateMetadata(), asB)).toBe('https://b.cliente.es/eventos');
  });

  it('la ficha de producto, abierta por id, apunta a la ruta del slug', async () => {
    const p = await tenantClient('a').product.create({ data: { name: 'Taza', slug: 'taza', price: 9, isActive: true } });
    const { generateMetadata } = await import('@/app/(public)/tienda/[slug]/page');
    const byId = (await asA(() => generateMetadata({ params: { slug: p.id } }))) as { alternates?: { canonical?: string } };
    expect(byId.alternates?.canonical).toBe('https://a.cliente.es/tienda/taza');
  });
});

describe('imagen social de la ficha (Open Graph y Twitter)', () => {
  const OG = 'https://abc123.public.blob.vercel-storage.com/marca/og.png';
  type Meta = { openGraph?: { title?: string; siteName?: string; images?: { url: string }[] }; twitter?: { card?: string; images?: string[] } };
  const withBrandImage = () => {
    const theme = JSON.stringify({ v: 1, template: 'editorial', colors: { primary: '#1d4ed8', accent: '#f59e0b' }, brand: { name: 'Sala' }, assets: { ogImage: OG } });
    return tenantClient('a').appConfig.create({ data: { key: 'site_theme', value: theme, label: 'x', group: 'brand' } });
  };

  it('un evento con cartel usa su cartel en las dos redes; sin cartel, la imagen social de la marca (no se comparte sin imagen)', async () => {
    await withBrandImage();
    await createEvent('a', 'con-cartel', { imageUrl: 'https://abc123.public.blob.vercel-storage.com/a/cartel.jpg' });
    await createEvent('a', 'sin-cartel', { imageUrl: null });
    const { generateMetadata } = await import('@/app/(public)/eventos/[slug]/page');
    const withPoster = (await asA(() => generateMetadata({ params: { slug: 'con-cartel' } }))) as Meta;
    expect(withPoster.openGraph?.images?.[0]?.url).toBe('https://abc123.public.blob.vercel-storage.com/a/cartel.jpg');
    expect(withPoster.twitter?.images).toEqual(['https://abc123.public.blob.vercel-storage.com/a/cartel.jpg']);
    const without = (await asA(() => generateMetadata({ params: { slug: 'sin-cartel' } }))) as Meta;
    expect(without.openGraph?.images?.[0]?.url).toBe(OG);
    expect(without.twitter?.images).toEqual([OG]);
    expect(without.openGraph).toMatchObject({ title: 'Evento sin-cartel', siteName: 'Sala' }); // el openGraph de la página sustituye al raíz: va completo
    expect(without.twitter?.card).toBe('summary_large_image');
  });

  it('un producto sin foto también cae a la imagen social de la marca', async () => {
    await withBrandImage();
    await tenantClient('a').product.create({ data: { name: 'Taza', slug: 'taza', price: 9, isActive: true } });
    const { generateMetadata } = await import('@/app/(public)/tienda/[slug]/page');
    const meta = (await asA(() => generateMetadata({ params: { slug: 'taza' } }))) as Meta;
    expect(meta.openGraph?.images?.[0]?.url).toBe(OG);
    expect(meta.twitter?.images).toEqual([OG]);
  });

  it('sin cartel ni imagen de marca no se inventa ninguna imagen', async () => {
    await createEvent('a', 'sin-nada', { imageUrl: null });
    const { generateMetadata } = await import('@/app/(public)/eventos/[slug]/page');
    const meta = (await asA(() => generateMetadata({ params: { slug: 'sin-nada' } }))) as Meta;
    expect(meta.openGraph?.images).toBeUndefined();
    expect(meta.twitter).toBeUndefined();
  });
});

describe('ficha de evento: robots y datos estructurados', () => {
  it('un evento ya pasado sigue con sus datos pero sin ofertas de compra', async () => {
    await createEvent('a', 'pasado', { date: new Date('2020-01-01T20:00:00Z') });
    const { default: Page } = await import('@/app/(public)/eventos/[slug]/page');
    const [ld] = ldScripts(await asA(() => Page({ params: { slug: 'pasado' } }))) as Array<Record<string, any>>;
    expect(ld?.['@type']).toBe('Event');
    expect(ld?.offers).toBeUndefined();
  });

  it('un evento publicado: canónica, indexable y con JSON-LD de Event (fecha, lugar, oferta, dominio del cliente)', async () => {
    await createEvent('a', 'concierto');
    const { generateMetadata, default: Page } = await import('@/app/(public)/eventos/[slug]/page');
    const meta = (await asA(() => generateMetadata({ params: { slug: 'concierto' } }))) as { alternates?: { canonical?: string }; robots?: unknown };
    expect(meta.alternates?.canonical).toBe('https://a.cliente.es/eventos/concierto');
    expect(meta.robots).toBeUndefined();

    const tree = await asA(() => Page({ params: { slug: 'concierto' } }));
    const [ld] = ldScripts(tree) as Array<Record<string, any>>;
    expect(ld?.['@type']).toBe('Event');
    expect(ld?.startDate).toBe('2030-05-01T20:00:00.000Z');
    expect(ld?.url).toBe('https://a.cliente.es/eventos/concierto');
    expect(ld?.offers?.[0]).toMatchObject({ price: '12.00', availability: 'https://schema.org/InStock', url: 'https://a.cliente.es/eventos/concierto/comprar' });
  });

  it('un borrador se puede abrir por URL pero lleva noindex y no publica datos estructurados', async () => {
    await createEvent('a', 'borrador', { status: 'DRAFT' });
    const { generateMetadata, default: Page } = await import('@/app/(public)/eventos/[slug]/page');
    const meta = (await asA(() => generateMetadata({ params: { slug: 'borrador' } }))) as { robots?: { index?: boolean } };
    expect(meta.robots?.index).toBe(false);
    const tree = await asA(() => Page({ params: { slug: 'borrador' } }));
    expect(ldScripts(tree)).toHaveLength(0);
  });

  it('el día del evento es el de Madrid, no el del servidor (UTC): un evento a la 01:30 del día 2 no sale como el 1', async () => {
    const feria = JSON.stringify({ v: 1, template: 'feria', colors: { primary: '#3d2fd5', accent: '#c5e63a' }, brand: { name: 'Sala' } });
    await tenantClient('a').appConfig.create({ data: { key: 'site_theme', value: feria, label: 'x', group: 'brand' } });
    await createEvent('a', 'madrugada', { date: new Date('2030-05-01T23:30:00Z') }); // 02/05/2030 01:30 en Madrid (CEST)
    const { default: Page } = await import('@/app/(public)/eventos/[slug]/page');
    const shown = texts(await asA(() => Page({ params: { slug: 'madrugada' } }))).join(' ');
    expect(shown).toMatch(/2 de mayo de 2030/);
    expect(shown).not.toMatch(/1 de mayo de 2030/);
  });

  it('cabecera de Feria: con horas se enseña «apertura — cierre»; sin ninguna, ni rastro del guion', async () => {
    const feria = JSON.stringify({ v: 1, template: 'feria', colors: { primary: '#3d2fd5', accent: '#c5e63a' }, brand: { name: 'Sala' } });
    await tenantClient('a').appConfig.create({ data: { key: 'site_theme', value: feria, label: 'x', group: 'brand' } });
    await createEvent('a', 'sin-horas');
    await createEvent('a', 'con-horas', { doorsOpen: '21:00', endTime: '03:00' });
    const { default: Page } = await import('@/app/(public)/eventos/[slug]/page');
    const without = texts(await asA(() => Page({ params: { slug: 'sin-horas' } })));
    const withTimes = texts(await asA(() => Page({ params: { slug: 'con-horas' } })));
    expect(without.some((t) => t.trim() === '—')).toBe(false);
    expect(withTimes).toContain('21:00 — 03:00');
  });
});
