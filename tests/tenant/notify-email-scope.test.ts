import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getOperatorEmail } from '@/lib/config';
import { configKeyOwners, invalidConfigValue } from '@/lib/config-ownership';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Revisión de módulos (2026-10): todos los avisos de operación iban a un único `admin_email`. Cada módulo puede tener el suyo
 * (quien lleva la tienda recibe lo de la tienda, no los avisos de patrocinios), con `admin_email` como respaldo. */

let env: ReturnType<typeof enablePlatformEnv>;
beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
}, 180_000);
beforeEach(async () => {
  await resetTenantDatabase('a');
  await tenantClient('a').appConfig.create({ data: { key: 'admin_email', value: 'general@cliente.es', label: 'x', group: 'general' } });
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

const set = (key: string, value: string) => tenantClient('a').appConfig.create({ data: { key, value, label: key, group: 'general' } });
const emailFor = (scope?: 'contacto' | 'entradas' | 'tienda' | 'sponsors') => withTenantForTest('a', () => getOperatorEmail(scope));

describe('Correo de avisos por módulo', () => {
  it('sin un correo propio, todos los módulos avisan al de administración (como hasta ahora)', async () => {
    for (const s of [undefined, 'contacto', 'entradas', 'tienda', 'sponsors'] as const) expect(await emailFor(s), String(s)).toBe('general@cliente.es');
  });

  it('un módulo con correo propio lo usa; los demás siguen con el general', async () => {
    await set('notify_email_tienda', 'tienda@cliente.es');
    expect(await emailFor('tienda')).toBe('tienda@cliente.es');
    expect(await emailFor('entradas')).toBe('general@cliente.es');
    expect(await emailFor()).toBe('general@cliente.es');
  });

  it('un correo propio vacío o con espacios se ignora', async () => {
    await set('notify_email_sponsors', '   ');
    expect(await emailFor('sponsors')).toBe('general@cliente.es');
  });

  it('cada clave pertenece a su módulo y se valida como email', () => {
    expect(configKeyOwners('notify_email_contacto')).toEqual(['nucleo']);
    expect(configKeyOwners('notify_email_entradas')).toEqual(['entradas']);
    expect(configKeyOwners('notify_email_tienda')).toEqual(['tienda']);
    expect(configKeyOwners('notify_email_sponsors')).toEqual(['sponsors']);
    expect(invalidConfigValue('notify_email_tienda', 'no-es-email')).not.toBeNull();
    expect(invalidConfigValue('notify_email_tienda', 'ok@cliente.es')).toBeNull();
  });
});
