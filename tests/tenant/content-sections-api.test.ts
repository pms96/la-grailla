import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { SECTION_CONFIG_KEYS, parseSection } from '@/lib/content/sections';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Las secciones de contenido (servicios, proyectos, equipo, preguntas frecuentes) son del núcleo: un cliente sin Entradas ni Tienda las puede
 * editar, la API rechaza lo que el panel no debe guardar y un rol sin el núcleo no las toca. */

const state = vi.hoisted(() => ({ modules: null as string[] | null }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'u1', role: 'ADMIN', modules: state.modules } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

let env: ReturnType<typeof enablePlatformEnv>;
const SOLO_NUCLEO = ['nucleo'];

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
}, 180_000);
beforeEach(async () => {
  state.modules = null;
  await resetTenantDatabase('a');
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

const put = async (configs: { key: string; value: string }[], modules: string[], userModules: string[] | null = null) => {
  state.modules = userModules;
  const { PUT } = await import('@/app/api/admin/config/route');
  return withTenantForTest('a', () => PUT(new Request('http://a.cliente.test/api/admin/config', { method: 'PUT', body: JSON.stringify({ configs }) })), { modules });
};
const getKeys = async (modules: string[]) => {
  const { GET } = await import('@/app/api/admin/config/route');
  const res = await withTenantForTest('a', () => GET(), { modules });
  return ((await res.json()) as { key: string }[]).map((c) => c.key);
};
const stored = async (key: string) => (await tenantClient('a').appConfig.findUnique({ where: { key } }))?.value ?? null;

const servicios = JSON.stringify({ title: 'Qué hacemos', intro: '', items: [{ title: 'Diseño web', text: 'A medida.', meta: 'Desde 300 €', imageUrl: '', href: 'https://ejemplo.es' }] });
const faq = JSON.stringify({ title: '', intro: '', items: [{ title: '¿Cuánto tarda?', text: 'Entre cuatro y ocho semanas.', meta: '', imageUrl: '', href: '' }] });

describe('PUT /api/admin/config — secciones de contenido', () => {
  it('un cliente solo con el núcleo (sin Entradas ni Tienda) las guarda y las lee tal cual', async () => {
    const res = await put([{ key: SECTION_CONFIG_KEYS.servicios, value: servicios }, { key: SECTION_CONFIG_KEYS.faq, value: faq }], SOLO_NUCLEO);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored: string[] }).ignored).toEqual([]);
    expect(parseSection(await stored(SECTION_CONFIG_KEYS.servicios), 'servicios').items[0]).toMatchObject({ title: 'Diseño web', href: 'https://ejemplo.es' });
    expect(parseSection(await stored(SECTION_CONFIG_KEYS.faq), 'faq').items).toHaveLength(1);
    expect(await getKeys(SOLO_NUCLEO)).toEqual(expect.arrayContaining([SECTION_CONFIG_KEYS.servicios, SECTION_CONFIG_KEYS.faq]));
  });

  it('vaciar una sección (valor vacío) la deja sin contenido', async () => {
    await put([{ key: SECTION_CONFIG_KEYS.servicios, value: servicios }], SOLO_NUCLEO);
    const res = await put([{ key: SECTION_CONFIG_KEYS.servicios, value: '' }], SOLO_NUCLEO);
    expect(res.status).toBe(200);
    expect(parseSection(await stored(SECTION_CONFIG_KEYS.servicios), 'servicios').items).toHaveLength(0);
  });

  it('un enlace peligroso se rechaza con 400 y NO se guarda nada del envío (ni lo que iba bien)', async () => {
    const mala = JSON.stringify({ title: '', intro: '', items: [{ title: 'Diseño', text: '', meta: '', imageUrl: '', href: 'javascript:alert(1)' }] });
    const res = await put([{ key: SECTION_CONFIG_KEYS.faq, value: faq }, { key: SECTION_CONFIG_KEYS.servicios, value: mala }], SOLO_NUCLEO);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/home_section_servicios.*enlace/);
    expect(await stored(SECTION_CONFIG_KEYS.faq)).toBeNull();
    expect(await stored(SECTION_CONFIG_KEYS.servicios)).toBeNull();
  });

  it('una imagen que no es del panel se rechaza; un JSON roto también', async () => {
    const ajena = JSON.stringify({ title: '', intro: '', items: [{ title: 'Ana', text: '', meta: '', imageUrl: 'https://otro-sitio.com/a.jpg', href: '' }] });
    expect((await put([{ key: SECTION_CONFIG_KEYS.equipo, value: ajena }], SOLO_NUCLEO)).status).toBe(400);
    expect((await put([{ key: SECTION_CONFIG_KEYS.equipo, value: '{no es json' }], SOLO_NUCLEO)).status).toBe(400);
    expect(await stored(SECTION_CONFIG_KEYS.equipo)).toBeNull();
  });

  it('un rol sin el núcleo (solo Tienda) no las puede guardar', async () => {
    const res = await put([{ key: SECTION_CONFIG_KEYS.servicios, value: servicios }], ['nucleo', 'tienda'], ['tienda']);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored: string[] }).ignored).toEqual([SECTION_CONFIG_KEYS.servicios]);
    expect(await stored(SECTION_CONFIG_KEYS.servicios)).toBeNull();
  });
});
