import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ONBOARDING_REQUIRED_CONFIG } from '@grailla/contracts';
import { getOnboardingNotice, getOnboardingStatus, onboardingApplies, onboardingNoticeText } from '@/lib/onboarding';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* M7: datos mínimos para publicar a un cliente nuevo. El aviso del panel solo existe en modo plataforma y para clientes que no son el legacy. */

let env: ReturnType<typeof enablePlatformEnv>;

beforeAll(async () => {
  await ensureTenantDatabases();
}, 180_000);
beforeEach(async () => {
  env = enablePlatformEnv();
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
});
afterEach(() => env.restore());
afterAll(async () => {
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

const set = (slot: 'a' | 'b', key: string, value: string) => tenantClient(slot).appConfig.create({ data: { key, value } });
async function fill(slot: 'a' | 'b') {
  await set(slot, 'admin_email', 'duena@cliente.es');
  await set(slot, 'legal_notice', 'Aviso legal del cliente');
  await set(slot, 'privacy_policy', 'Política de privacidad del cliente');
  await set(slot, 'cookies_policy', 'Política de cookies del cliente');
}

describe('getOnboardingStatus', () => {
  it('un cliente nuevo y vacío: falta todo (y no hereda el correo ni los textos de La Grailla)', async () => {
    const status = await withTenantForTest('a', () => getOnboardingStatus());
    expect(status).toEqual({ complete: false, missing: [...ONBOARDING_REQUIRED_CONFIG] });
  });

  it('con los cuatro datos: listo', async () => {
    await fill('a');
    expect(await withTenantForTest('a', () => getOnboardingStatus())).toEqual({ complete: true, missing: [] });
  });

  it('un texto de solo espacios o un correo que no lo parece no cuentan', async () => {
    await set('a', 'admin_email', 'no-es-un-correo');
    await set('a', 'legal_notice', '   ');
    await set('a', 'privacy_policy', 'Política');
    await set('a', 'cookies_policy', 'Cookies');
    const status = await withTenantForTest('a', () => getOnboardingStatus());
    expect(status.missing).toEqual(['admin_email', 'legal_notice']);
    expect(status.complete).toBe(false);
  });

  it('es por cliente: completar A no completa B', async () => {
    await fill('a');
    expect((await withTenantForTest('a', () => getOnboardingStatus())).complete).toBe(true);
    expect((await withTenantForTest('b', () => getOnboardingStatus())).complete).toBe(false);
  });
});

describe('aviso del panel (getOnboardingNotice)', () => {
  it('cliente nuevo con algo pendiente: lista lo que falta; completo: nada', async () => {
    expect(await withTenantForTest('a', () => getOnboardingNotice())).toEqual([...ONBOARDING_REQUIRED_CONFIG]);
    await fill('a');
    expect(await withTenantForTest('a', () => getOnboardingNotice())).toEqual([]);
  });

  it('el cliente legacy nunca lo ve, aunque le falte todo', async () => {
    expect(await withTenantForTest('a', () => onboardingApplies(), { tenantId: env.LEGACY_TENANT_ID })).toBe(false);
    expect(await withTenantForTest('a', () => getOnboardingNotice(), { tenantId: env.LEGACY_TENANT_ID })).toEqual([]);
  });

  it('en modo normal nunca se muestra', async () => {
    env.restore(); // PLATFORM_MODE apagado
    expect(onboardingApplies()).toBe(false);
    expect(await getOnboardingNotice()).toEqual([]);
  });

  it('el texto del aviso nombra cada dato pendiente', () => {
    expect(onboardingNoticeText(['admin_email', 'privacy_policy'])).toBe('Completa estos datos antes de publicar la web: correo de avisos, política de privacidad.');
  });
});
