import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBrand, legacySeedTheme } from '@/lib/brand/brand';
import { getConfig, getOperatorEmail } from '@/lib/config';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import {
  TEST_TENANT_IDS,
  disconnectTenantClients,
  ensureTenantDatabases,
  resetTenantDatabase,
  tenantClient,
  withTenantForTest,
} from '../helpers/tenant-dbs';

/* Marca por cliente (M6): cada cliente tiene su apariencia, un cliente nuevo no hereda NADA de La Grailla, el tema solo se escribe por su
 * API (validado) y lo que haya en la BD se valida al leer. Dos BDs reales. */

let sessionRole: 'ADMIN' | 'TAQUILLA' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'brand-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const theme = (name: string, primary: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  template: 'editorial',
  mode: 'light',
  radius: 'suave',
  colors: { primary, accent: '#f59e0b' },
  fonts: { display: 'inter', body: 'inter' },
  assets: {},
  brand: { name, tagline: `Eslogan de ${name}`, description: '', legalName: '', sticker: '' },
  ...extra,
});

const BLOB = 'https://store123.public.blob.vercel-storage.com';
const put = (body: unknown) => new Request('http://localhost/api/admin/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let env: ReturnType<typeof enablePlatformEnv>;
let themeRoute: typeof import('@/app/api/admin/theme/route');
let configRoute: typeof import('@/app/api/admin/config/route');

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
  themeRoute = await import('@/app/api/admin/theme/route');
  configRoute = await import('@/app/api/admin/config/route');
}, 180_000);
beforeEach(async () => {
  sessionRole = 'ADMIN';
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('un cliente nuevo no hereda la marca de La Grailla', () => {
  it('sin tema: su dominio como nombre, sin logo, sin textos ni correo de La Grailla', async () => {
    const brand = await withTenantForTest('a', () => getBrand());
    expect(brand.name).toBe('a.cliente.es');
    expect(brand.logoOnDark).toBeNull();
    expect(brand.logoOnLight).toBeNull();
    expect(brand.stickerImage).toBeNull();
    expect(brand.contactEmail).toBe('');
    expect(JSON.stringify(brand)).not.toMatch(/grailla/i);
  });

  it('los textos por defecto de la portada y del pie salen vacíos (nunca los de La Grailla)', async () => {
    for (const key of ['footer_tagline', 'footer_copyright', 'home_hero_subtitle_1', 'home_hero_subtitle_2', 'home_hero_badge_fallback', 'home_shop_title', 'home_shop_subtitle', 'home_events_more_subtitle', 'smtp_from_name', 'admin_email']) {
      expect(await withTenantForTest('a', () => getConfig(key)), key).toBe('');
    }
  });

  it('el formulario de contacto viene encendido para un cliente nuevo', async () => {
    expect(await withTenantForTest('a', () => getConfig('contact_form_enabled'))).toBe('true');
  });
});

describe('el cliente legacy (La Grailla) conserva su marca y sus textos', () => {
  it('sin tema guardado: la marca de La Grailla y sin CSS añadido', async () => {
    const legacy = enablePlatformEnv({ LEGACY_TENANT_ID: TEST_TENANT_IDS.a });
    try {
      const brand = await withTenantForTest('a', () => getBrand());
      expect(brand.name).toBe('La Grailla');
      expect(brand.theme).toBeNull();
      expect(brand.logoOnDark).toBe('/brand/logo-white.png');
      expect(await withTenantForTest('a', () => getConfig('footer_tagline'))).toContain('Caseta de feria');
      expect(await withTenantForTest('a', () => getConfig('home_shop_title'))).toBe('Merch oficial');
      // …pero el formulario de contacto, nuevo, no se enciende solo en una web que no lo tenía.
      expect(await withTenantForTest('a', () => getConfig('contact_form_enabled'))).toBe('false');
      // …y sus avisos siguen yendo a su dirección si no guardó otra.
      expect(await withTenantForTest('a', () => getOperatorEmail())).toBe('grupolagrailla@gmail.com');
    } finally {
      legacy.restore();
      env = enablePlatformEnv();
    }
  });
});

describe('cada cliente, su tema', () => {
  it('guardar el tema de A no cambia el de B y cada uno lee el suyo', async () => {
    expect((await withTenantForTest('a', () => themeRoute.PUT(put(theme('Sala Norte', '#0f766e'))))).status).toBe(200);
    expect((await withTenantForTest('b', () => themeRoute.PUT(put(theme('Verbena Club', '#be123c'))))).status).toBe(200);

    const a = await withTenantForTest('a', () => getBrand());
    const b = await withTenantForTest('b', () => getBrand());
    expect(a.name).toBe('Sala Norte');
    expect(b.name).toBe('Verbena Club');
    expect(a.colors.primary).toBe('#0f766e');
    expect(b.colors.primary).toBe('#be123c');
    expect(a.tagline).toBe('Eslogan de Sala Norte');

    // Cada tema vive en la BD de su cliente.
    expect(await tenantClient('a').appConfig.count({ where: { key: 'site_theme' } })).toBe(1);
    expect(JSON.parse((await tenantClient('b').appConfig.findUniqueOrThrow({ where: { key: 'site_theme' } })).value).brand.name).toBe('Verbena Club');
  });

  it('GET devuelve el punto de partida del cliente (neutro) y luego lo guardado', async () => {
    const first = await (await withTenantForTest('a', () => themeRoute.GET())).json();
    expect(first.saved).toBe(false);
    expect(first.theme.brand.name).toBe('a.cliente.es');
    await withTenantForTest('a', () => themeRoute.PUT(put(theme('Sala Norte', '#0f766e'))));
    const second = await (await withTenantForTest('a', () => themeRoute.GET())).json();
    expect(second.saved).toBe(true);
    expect(second.theme.brand.name).toBe('Sala Norte');
  });

  it('DELETE vuelve a la apariencia neutra', async () => {
    await withTenantForTest('a', () => themeRoute.PUT(put(theme('Sala Norte', '#0f766e'))));
    expect((await withTenantForTest('a', () => themeRoute.DELETE())).status).toBe(200);
    expect((await withTenantForTest('a', () => getBrand())).name).toBe('a.cliente.es');
  });
});

describe('PUT /api/admin/theme valida lo que se guarda', () => {
  it('solo ADMIN', async () => {
    sessionRole = 'TAQUILLA';
    expect((await withTenantForTest('a', () => themeRoute.PUT(put(theme('X', '#0f766e'))))).status).toBe(401);
    expect((await withTenantForTest('a', () => themeRoute.GET())).status).toBe(401);
    expect((await withTenantForTest('a', () => themeRoute.DELETE())).status).toBe(401);
    sessionRole = null;
    expect((await withTenantForTest('a', () => themeRoute.PUT(put(theme('X', '#0f766e'))))).status).toBe(401);
    expect(await tenantClient('a').appConfig.count({ where: { key: 'site_theme' } })).toBe(0);
  });

  it.each([
    ['color con inyección de CSS', theme('X', '#fff;}body{display:none')],
    ['tipografía fuera del catálogo', theme('X', '#0f766e', { fonts: { display: 'comic-sans', body: 'inter' } })],
    ['cuerpo vacío', {}],
  ])('rechaza %s (400) y no guarda nada', async (_n, body) => {
    expect((await withTenantForTest('a', () => themeRoute.PUT(put(body)))).status).toBe(400);
    expect(await tenantClient('a').appConfig.count({ where: { key: 'site_theme' } })).toBe(0);
  });

  it('rechaza unos colores ilegibles (422) con el motivo', async () => {
    const res = await withTenantForTest('a', () => themeRoute.PUT(put(theme('X', '#0f766e', { colors: { primary: '#0f766e', accent: '#f59e0b', surfaceDark: '#f5f5f5' } }))));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.details.join(' ')).toMatch(/contraste/);
    expect(await tenantClient('a').appConfig.count({ where: { key: 'site_theme' } })).toBe(0);
  });

  it('un logo tiene que ser un fichero de ESTE cliente: el prefijo de otro cliente, un host ajeno y /brand/ no valen', async () => {
    const logo = (url: string) => theme('X', '#0f766e', { assets: { logoOnDark: url } });
    const mine = `${BLOB}/${TEST_TENANT_IDS.a}/brand/logo.png`;
    const others = `${BLOB}/${TEST_TENANT_IDS.b}/brand/logo.png`;
    expect((await withTenantForTest('a', () => themeRoute.PUT(put(logo(others))))).status).toBe(400);
    expect((await withTenantForTest('a', () => themeRoute.PUT(put(logo('https://evil.example/logo.png'))))).status).toBe(400);
    expect((await withTenantForTest('a', () => themeRoute.PUT(put(logo('/brand/logo-white.png'))))).status).toBe(400); // es de La Grailla
    expect((await withTenantForTest('a', () => themeRoute.PUT(put(logo(`${BLOB}/${TEST_TENANT_IDS.a}/../${TEST_TENANT_IDS.b}/x.png`))))).status).toBe(400);
    expect(await tenantClient('a').appConfig.count({ where: { key: 'site_theme' } })).toBe(0);
    expect((await withTenantForTest('a', () => themeRoute.PUT(put(logo(mine))))).status).toBe(200);
    expect((await withTenantForTest('a', () => getBrand())).logoOnDark).toBe(mine);
  });

  it('el PUT genérico de configuración no puede escribir el tema', async () => {
    const evil = JSON.stringify(theme('Evil', '#ff0000'));
    const res = await withTenantForTest('a', () =>
      configRoute.PUT(new Request('http://localhost', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: [{ key: 'site_theme', value: evil }] }) }))
    );
    expect(res.status).toBe(200);
    expect(await tenantClient('a').appConfig.count({ where: { key: 'site_theme' } })).toBe(0);
    expect((await withTenantForTest('a', () => getBrand())).name).toBe('a.cliente.es');
  });
});

describe('lo que haya en la BD se valida al leer', () => {
  it.each([
    ['JSON roto', '{no es json'],
    ['color con inyección escrito a mano', JSON.stringify(theme('X', '#fff;}body{display:none'))],
    ['logo de otro host escrito a mano', JSON.stringify(theme('X', '#0f766e', { assets: { logoOnDark: 'https://evil.example/x.png' } }))],
    ['versión futura', JSON.stringify({ ...theme('X', '#0f766e'), v: 99 })],
  ])('%s → marca neutra, nunca CSS ni imágenes del valor corrupto', async (_n, raw) => {
    await tenantClient('a').appConfig.create({ data: { key: 'site_theme', value: raw } });
    const brand = await withTenantForTest('a', () => getBrand());
    expect(brand.name).toBe('a.cliente.es');
    expect(brand.logoOnDark).toBeNull();
    expect(brand.colors.primary).toBe('#1d4ed8');
  });
});

describe('subidas directas a Blob (sponsors): el prefijo del cliente lo pone el servidor', () => {
  it('en modo plataforma la carpeta lleva el id del cliente; las URL de otro cliente o sin prefijo se rechazan', async () => {
    const { sponsorBlobPrefix, sponsorFinalVideoBlobPrefix } = await import('@/lib/sponsor-uploads');
    const { tenantBlobPrefix } = await import('@/lib/tenant/blob');
    const { isBlobUrlUnder } = await import('@/lib/blob-url');
    const prefixA = withTenantForTest('a', () => tenantBlobPrefix());
    expect(prefixA).toBe(`${TEST_TENANT_IDS.a}/`);
    const folderA = sponsorBlobPrefix(prefixA, 'sp1');
    expect(folderA).toBe(`${TEST_TENANT_IDS.a}/sponsors/sp1/`);
    expect(sponsorFinalVideoBlobPrefix(prefixA, 'sp1')).toBe(`${TEST_TENANT_IDS.a}/sponsors/sp1/final-video/`);

    const mine = `${BLOB}/${TEST_TENANT_IDS.a}/sponsors/sp1/logo.png`;
    const others = `${BLOB}/${TEST_TENANT_IDS.b}/sponsors/sp1/logo.png`;
    const legacyPath = `${BLOB}/sponsors/sp1/logo.png`;
    expect(isBlobUrlUnder(mine, folderA)).toBe(true);
    expect(isBlobUrlUnder(others, folderA)).toBe(false); // mismo id de sponsor, otro cliente
    expect(isBlobUrlUnder(legacyPath, folderA)).toBe(false); // la ruta sin prefijo ya no vale en modo plataforma
  });
});

describe('el cliente legacy puede guardar su apariencia original', () => {
  it('el tema semilla de La Grailla (con sus iconos fijos) se guarda tal cual y, para otro cliente, esos ficheros no valen', async () => {
    const seed = legacySeedTheme();
    const legacy = enablePlatformEnv({ LEGACY_TENANT_ID: TEST_TENANT_IDS.a });
    try {
      expect((await withTenantForTest('a', () => themeRoute.PUT(put(seed)))).status).toBe(200);
      expect((await withTenantForTest('a', () => getBrand())).name).toBe('La Grailla');
      // Para el cliente B (no legacy) el mismo tema se rechaza, diciendo QUÉ imagen no es suya.
      const res = await withTenantForTest('b', () => themeRoute.PUT(put(seed)));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/logoOnDark/);
    } finally {
      legacy.restore();
      env = enablePlatformEnv();
    }
  });

  it('el rechazo de un tema inválido nombra el campo', async () => {
    const res = await withTenantForTest('a', () => themeRoute.PUT(put(theme('X', '#0f766e', { assets: { favicon: 'https://evil.example/x.png' } }))));
    expect(res.status).toBe(400);
    expect((await res.json()).details.join(' ')).toContain('assets.favicon');
  });
});
