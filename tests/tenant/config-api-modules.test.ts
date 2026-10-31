import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Revisión de módulos (2026-10): la API de configuración devolvía y aceptaba todas las claves de todos los módulos. */

const state = vi.hoisted(() => ({ modules: null as string[] | null }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'u1', role: 'ADMIN', modules: state.modules } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

let env: ReturnType<typeof enablePlatformEnv>;
const TODO = ['nucleo', 'entradas', 'tienda', 'contabilidad', 'sponsors', 'wallets'];

const seed = () =>
  tenantClient('a').appConfig.createMany({
    data: [
      { key: 'admin_email', value: 'dueno@cliente.es', label: 'x', group: 'general' },
      { key: 'smtp_host', value: 'smtp.dueno.es', label: 'x', group: 'general' },
      { key: 'social_instagram', value: '@dueno', label: 'x', group: 'social' },
      { key: 'commission_percentage', value: '15', label: 'x', group: 'payment' },
      { key: 'sponsor_tiers', value: '[]', label: 'x', group: 'sponsors' },
      { key: 'google_wallet_issuer_id', value: '3388', label: 'x', group: 'wallets' },
      { key: 'shop_sumup_merchant_code', value: 'MCSHOP', label: 'x', group: 'payment' },
      { key: 'site_theme', value: '{"v":1}', label: 'x', group: 'brand' },
      { key: 'apple_wallet_cert_expiry_alerted_for', value: '2026-01-01', label: 'x', group: 'wallets' },
      { key: 'clave_inventada', value: 'x', label: 'x', group: 'otros' },
    ],
  });

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

const getKeys = async (modules: string[]) => {
  const { GET } = await import('@/app/api/admin/config/route');
  const res = await withTenantForTest('a', () => GET(), { modules });
  return ((await res.json()) as { key: string }[]).map((c) => c.key).sort();
};
const put = async (configs: { key: string; value: string }[], modules: string[]) => {
  const { PUT } = await import('@/app/api/admin/config/route');
  return withTenantForTest('a', () => PUT(new Request('http://a.cliente.test/api/admin/config', { method: 'PUT', body: JSON.stringify({ configs }) })), { modules });
};
const stored = async (key: string) => (await tenantClient('a').appConfig.findUnique({ where: { key } }))?.value ?? null;

describe('GET /api/admin/config — solo las claves de los módulos activos', () => {
  it('sin Entradas, Sponsors ni Wallets no salen sus claves; la de la tienda sí con Tienda', async () => {
    await seed();
    const keys = await getKeys(['nucleo', 'tienda']);
    expect(keys).toContain('admin_email');
    expect(keys).toContain('shop_sumup_merchant_code');
    for (const k of ['commission_percentage', 'sponsor_tiers', 'google_wallet_issuer_id']) expect(keys, k).not.toContain(k);
  });

  it('las claves internas y las desconocidas nunca salen, con todos los módulos', async () => {
    await seed();
    const keys = await getKeys(TODO);
    for (const k of ['site_theme', 'apple_wallet_cert_expiry_alerted_for', 'clave_inventada']) expect(keys, k).not.toContain(k);
    expect(keys).toContain('commission_percentage');
    expect(keys).toContain('sponsor_tiers');
  });
});

describe('PUT /api/admin/config — solo guarda claves de módulos activos y valores válidos', () => {
  it('ignora la comisión sin el módulo Entradas pero guarda el resto', async () => {
    await seed();
    const res = await put([{ key: 'commission_percentage', value: '30' }, { key: 'admin_email', value: 'nuevo@cliente.es' }], ['nucleo', 'tienda']);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored: string[] }).ignored).toEqual(['commission_percentage']);
    expect(await stored('commission_percentage')).toBe('15');
    expect(await stored('admin_email')).toBe('nuevo@cliente.es');
  });

  it('con Entradas la comisión sí se guarda', async () => {
    await seed();
    await put([{ key: 'commission_percentage', value: '30' }], ['nucleo', 'entradas']);
    expect(await stored('commission_percentage')).toBe('30');
  });

  it('no crea claves desconocidas ni toca las internas', async () => {
    await seed();
    await put([{ key: 'otra_inventada', value: 'x' }, { key: 'site_theme', value: 'roto' }, { key: 'apple_wallet_cert_expiry_alerted_for', value: 'roto' }], TODO);
    expect(await stored('otra_inventada')).toBeNull();
    expect(await stored('site_theme')).toBe('{"v":1}');
    expect(await stored('apple_wallet_cert_expiry_alerted_for')).toBe('2026-01-01');
  });

  // H-058: la cuenta de cobro (claves de pasarela) es solo del propietario. Antes un gestor de tienda podía sustituirla y desviar todo cobro online a su cuenta.
  it('un gestor de tienda no ve ni guarda la cuenta de cobro de la tienda, ni las claves del núcleo ni las de otros módulos', async () => {
    await seed();
    state.modules = ['tienda'];
    const keys = await getKeys(TODO);
    expect(keys).toEqual([]);
    const res = await put([{ key: 'shop_sumup_merchant_code', value: 'MCNUEVO' }, { key: 'admin_email', value: 'robado@x.es' }, { key: 'commission_percentage', value: '99' }], TODO);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored: string[] }).ignored.sort()).toEqual(['admin_email', 'commission_percentage', 'shop_sumup_merchant_code']);
    expect(await stored('shop_sumup_merchant_code')).toBe('MCSHOP');
    expect(await stored('admin_email')).toBe('dueno@cliente.es');
  });

  it('un rol con el módulo núcleo ve las claves del núcleo (contenido, redes) pero NO el correo saliente ni el email de administración', async () => {
    await seed();
    state.modules = ['nucleo'];
    expect(await getKeys(TODO)).toEqual(['social_instagram']);
  });

  // P1-03: sin esto, el rol «Contenido y mensajes» podría sustituir el SMTP y desviar los correos con datos de compradores.
  it('un rol con el módulo núcleo NO puede cambiar el SMTP ni el email de administración, y sí el resto del núcleo', async () => {
    await seed();
    state.modules = ['nucleo'];
    const res = await put([
      { key: 'smtp_host', value: 'smtp.atacante.es' },
      { key: 'admin_email', value: 'atacante@x.es' },
      { key: 'social_instagram', value: '@nuevo' },
    ], TODO);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored: string[] }).ignored.sort()).toEqual(['admin_email', 'smtp_host']);
    expect(await stored('smtp_host')).toBe('smtp.dueno.es');
    expect(await stored('admin_email')).toBe('dueno@cliente.es');
    expect(await stored('social_instagram')).toBe('@nuevo');
  });

  it('el propietario sigue pudiendo cambiar el SMTP y el email de administración', async () => {
    await seed();
    await put([{ key: 'smtp_host', value: 'smtp.nuevo.es' }, { key: 'admin_email', value: 'nuevo@cliente.es' }], TODO);
    expect(await stored('smtp_host')).toBe('smtp.nuevo.es');
    expect(await stored('admin_email')).toBe('nuevo@cliente.es');
  });

  it('un valor inválido da 400 y no se guarda NADA de ese envío', async () => {
    await seed();
    const res = await put([{ key: 'admin_email', value: 'otro@cliente.es' }, { key: 'commission_percentage', value: '500' }], TODO);
    expect(res.status).toBe(400);
    expect(await stored('admin_email')).toBe('dueno@cliente.es');
    expect(await stored('commission_percentage')).toBe('15');
  });
});
