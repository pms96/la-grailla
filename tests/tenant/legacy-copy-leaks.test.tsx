import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { BrandProvider, type ClientBrand } from '@/components/brand-provider';
import { getActiveModules } from '@/lib/modules/runtime';
import { isLegacyTenant } from '@/lib/tenant/context';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { ShopReceiptPrinter, type ShopOrderView } from '@/app/(public)/tienda/confirmacion/[orderId]/_components/shop-confirmation-client';
import { ShopEmptyCatalog } from '@/app/(public)/tienda/_components/shop-grid';
import AdminShell from '@/app/admin/_components/admin-shell';
import { enablePlatformEnv } from '../helpers/platform';
import { TEST_TENANT_IDS, disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* P0-10: lo que ve un cliente que NO es La Grailla no puede llevar «caseta» ni «feria» (insensible a mayúsculas) fuera de una lista permitida
 * explícita, y La Grailla (el cliente legacy) conserva sus textos de siempre. Se renderiza con el cliente B (BD real de pruebas) las superficies
 * afectadas: confirmación de tienda, tienda vacía, patrocinio, eventos (plantillas editorial y feria) y el menú del admin. */

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: 'Ana', email: 'ana@b.es', modules: null } } }),
  signOut: vi.fn(),
}));
vi.mock('next/navigation', async (importOriginal) => ({ ...(await importOriginal<typeof import('next/navigation')>()), usePathname: () => '/admin' }));
// `cache` solo existe en la build de React que usa Next para componentes de servidor; aquí basta con que ejecute la función.
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí.
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
const visibleText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Lo único que puede aparecer con «caseta»/«feria» para un cliente nuevo. Vacío a propósito: hoy no hay ninguna excepción. Añadir aquí un texto exige
 *  justificarlo en la revisión (p. ej. el nombre de una plantilla que el propio cliente eligió). */
const ALLOWED: readonly RegExp[] = [];
const LEAK = /caseta|feria/i;
function expectNoLeak(html: string, where: string) {
  let text = visibleText(html);
  for (const ok of ALLOWED) text = text.replace(ok, '');
  const m = text.match(new RegExp(`.{0,40}(${LEAK.source}).{0,40}`, 'i'));
  expect(m, `${where}: «${m?.[0]}»`).toBeNull();
  // Los atributos que se leen (textos alternativos, etiquetas accesibles, títulos) cuentan igual.
  for (const a of html.matchAll(/\s(?:alt|aria-label|title|placeholder)="([^"]*)"/g)) expect(a[1], `${where}: atributo`).not.toMatch(LEAK);
}

const MODULES = ['nucleo', 'entradas', 'tienda', 'sponsors', 'contabilidad'];
const clientBrand = (over: Partial<ClientBrand> = {}): ClientBrand => ({
  name: 'Club Norte',
  contactEmail: '',
  organizer: '"CLUB NORTE"',
  logoOnDark: null,
  logoOnLight: null,
  mode: 'light',
  contactFormEnabled: true,
  modules: getActiveModules(),
  legacy: isLegacyTenant(),
  blobPrefix: '',
  ...over,
});
const withBrand = (node: ReactNode, over: Partial<ClientBrand> = {}) => <BrandProvider value={clientBrand(over)}>{node}</BrandProvider>;

const theme = (template: string) =>
  JSON.stringify({
    v: 1,
    template,
    mode: 'light',
    radius: 'suave',
    colors: { primary: '#0f766e', accent: '#f59e0b' },
    fonts: { display: 'inter', body: 'inter' },
    assets: {},
    brand: { name: 'Club Norte', tagline: 'Pádel y más', description: '', legalName: '', sticker: '' },
  });

const order: ShopOrderView = {
  id: 'ckabcdef1234',
  status: 'PAID',
  buyerName: 'Lola',
  buyerEmail: 'lola@ejemplo.es',
  totalAmount: 25,
  shippingAddress: 'Calle Mayor 1',
  shippingCity: 'Valencia',
  shippingZip: '46001',
  shippingPhone: null,
  items: [{ id: 'i1', quantity: 1, unitPrice: 25, size: 'M', color: null, product: { name: 'Camiseta' } }],
};

let env: ReturnType<typeof enablePlatformEnv>;
let sponsorsPage: typeof import('@/app/(public)/sponsors/page');
let eventosPage: typeof import('@/app/(public)/eventos/page');
let homePage: typeof import('@/app/(public)/page');

const onB = <T,>(fn: () => T, modules: string[] = MODULES) => withTenantForTest('b', fn, { modules });
const setTheme = (template: string | null) =>
  template === null
    ? tenantClient('b').appConfig.deleteMany({ where: { key: 'site_theme' } })
    : tenantClient('b').appConfig.upsert({ where: { key: 'site_theme' }, update: { value: theme(template) }, create: { key: 'site_theme', value: theme(template) } });
const addEvent = () =>
  tenantClient('b').event.create({ data: { name: 'Torneo de verano', slug: 'torneo-verano', venue: 'Pista central', city: 'Valencia', date: new Date(Date.now() + 5 * 86_400_000), maxCapacity: 100, status: 'PUBLISHED' } });

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
  sponsorsPage = await import('@/app/(public)/sponsors/page');
  eventosPage = await import('@/app/(public)/eventos/page');
  homePage = await import('@/app/(public)/page');
}, 180_000);
beforeEach(async () => {
  await resetTenantDatabase('b');
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('cliente nuevo (B, no legacy): sin textos de La Grailla', () => {
  it('la confirmación de una compra de tienda despide con un texto neutro', async () => {
    const html = await onB(() => render(withBrand(<ShopReceiptPrinter order={order} />)));
    expect(html).toContain('Gracias por tu compra');
    expectNoLeak(html, 'recibo de tienda');
  });

  it('la tienda vacía solo enlaza a /eventos si el cliente tiene Entradas (TI-17)', async () => {
    const sinEntradas = await onB(() => render(withBrand(<ShopEmptyCatalog />)), ['nucleo', 'tienda']);
    expect(sinEntradas).not.toContain('/eventos');
    expect(sinEntradas).not.toContain('Ver eventos');
    expectNoLeak(sinEntradas, 'tienda vacía sin Entradas');

    const conEntradas = await onB(() => render(withBrand(<ShopEmptyCatalog />)));
    expect(conEntradas).toContain('href="/eventos"');
    expect(conEntradas).not.toContain('están el plan');
    expectNoLeak(conEntradas, 'tienda vacía con Entradas');
  });

  for (const template of [null, 'editorial', 'feria']) {
    const label = template ?? 'sin tema (editorial por defecto)';

    it(`patrocinio con la plantilla ${label}`, async () => {
      await setTheme(template);
      const html = await onB(async () => render(await sponsorsPage.default()));
      expectNoLeak(html, `/sponsors (${label})`);
      if (template === 'feria') expect(html).toContain('Tu marca con nosotros');
    });

    it(`eventos con la plantilla ${label}: sin fechas y con fechas`, async () => {
      await setTheme(template);
      const vacio = await onB(async () => render(await eventosPage.default()));
      expectNoLeak(vacio, `/eventos vacío (${label})`);
      await addEvent();
      const lleno = await onB(async () => render(await eventosPage.default()));
      expect(lleno).toContain('Torneo de verano');
      expectNoLeak(lleno, `/eventos con fechas (${label})`);
    });

    it(`portada sin eventos con la plantilla ${label}`, async () => {
      await setTheme(template);
      const html = await onB(async () => render(await homePage.default()));
      expectNoLeak(html, `portada (${label})`);
      expect(html).not.toContain('próxima fiesta');
    });
  }

  it('/eventos con la plantilla editorial es sobrio: cabecera editorial, sin el cartel de programación ni el sticker lima de Feria', async () => {
    await setTheme('editorial');
    await addEvent();
    const html = await onB(async () => render(await eventosPage.default()));
    expect(html).toContain('Próximos eventos');
    expect(html).toContain('Club Norte'); // el nombre del cliente va de rótulo
    expect(html).toMatch(/<h1[^>]*>\s*Próximos eventos\s*<\/h1>/);
    for (const feria of ['PROGRAMACIÓN', 'Noches que no se pierden', 'brand-sticker', 'hero-gradient', 'texture-noise']) expect(html, feria).not.toContain(feria);
    expect(html).toContain('/eventos/torneo-verano'); // reutiliza la tarjeta de evento de siempre
  });

  it('el menú del admin llama «Contabilidad» al grupo de Compras, Gastos e Ingresos', async () => {
    const html = await onB(() => render(withBrand(<AdminShell modules={getActiveModules()}>contenido</AdminShell>)));
    expect(html).toContain('Contabilidad');
    for (const item of ['Compras', 'Gastos', 'Ingresos']) expect(html).toContain(item);
    expectNoLeak(html, 'menú del admin');
  });
});

describe('La Grailla (cliente legacy): todo sigue como siempre', () => {
  beforeAll(() => {
    env.restore();
    env = enablePlatformEnv({ LEGACY_TENANT_ID: TEST_TENANT_IDS.b });
  });
  afterAll(() => {
    env.restore();
    env = enablePlatformEnv();
  });

  it('la confirmación de tienda conserva «¡Nos vemos en la caseta! 🍻»', async () => {
    const html = await onB(() => render(withBrand(<ShopReceiptPrinter order={order} />)));
    expect(visibleText(html)).toContain('¡Nos vemos en la caseta! 🍻');
    expect(html).not.toContain('Gracias por tu compra');
  });

  it('la tienda vacía conserva su frase y su enlace a /eventos', async () => {
    const html = await onB(() => render(withBrand(<ShopEmptyCatalog />)));
    expect(visibleText(html)).toContain('Mientras tanto, las entradas de los eventos están el plan.');
    expect(html).toContain('href="/eventos"');
  });

  it('patrocinio (Feria) conserva su cabecera y sus textos', async () => {
    const html = visibleText(await onB(async () => render(await sponsorsPage.default())));
    expect(html).toContain('PARA MARCAS');
    expect(html).toContain('Tu marca en la caseta');
    expect(html).toContain('Llegamos a miles de asistentes en vivo. Cuéntanos qué buscas y te respondemos con opciones concretas — sin formularios eternos.');
    expect(html).toContain('comunicaciones alrededor de cada noche.');
  });

  it('eventos (Feria) conserva el cartel de programación y el estado vacío de siempre', async () => {
    const html = await onB(async () => render(await eventosPage.default()));
    const text = visibleText(html);
    expect(text).toContain('PROGRAMACIÓN');
    expect(text).toContain('Noches que no se pierden');
    expect(text).toContain('Estamos cerrando la próxima noche. Cuando salga, aparecerá aquí primero.');
    expect(html).toContain('brand-sticker');
  });

  it('la portada vacía conserva «Estamos montando la próxima fiesta»', async () => {
    const html = visibleText(await onB(async () => render(await homePage.default())));
    expect(html).toContain('Estamos montando la próxima fiesta');
  });

  it('el menú del admin conserva el grupo «Caseta»', async () => {
    const html = await onB(() => render(withBrand(<AdminShell modules={getActiveModules()}>contenido</AdminShell>)));
    expect(visibleText(html)).toContain('Caseta');
    expect(visibleText(html)).not.toContain('Contabilidad');
  });
});
