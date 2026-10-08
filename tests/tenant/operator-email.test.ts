import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, getOperatorEmail } from '@/lib/config';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Revisión de seguridad de M4: los avisos de operación (solicitudes de patrocinio con datos personales, pagos sobre pedidos
 * anulados, certificados) iban a una dirección fija de La Grailla. En modo plataforma el destinatario es el `admin_email` DEL
 * CLIENTE, y si no lo configuró no se envía a nadie. */

const LEGACY = 'grupolagrailla@gmail.com';
let env: ReturnType<typeof enablePlatformEnv>;

beforeAll(async () => {
  await ensureTenantDatabases();
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

describe('destinatario de los avisos de operación', () => {
  it('modo normal: La Grailla, como siempre', async () => {
    expect(await getOperatorEmail()).toBe(LEGACY);
  });

  describe('modo plataforma', () => {
    beforeAll(() => {
      env = enablePlatformEnv();
    });
    afterAll(() => env.restore());

    it('un cliente sin admin_email NO hereda la dirección de La Grailla: no se envía a nadie', async () => {
      expect(await withTenantForTest('a', () => getOperatorEmail())).toBe('');
      expect(await withTenantForTest('a', () => getConfig('admin_email'))).toBe('');
    });

    it('cada cliente recibe sus avisos en SU dirección', async () => {
      await tenantClient('a').appConfig.create({ data: { key: 'admin_email', value: 'duena@cliente-a.es' } });
      await tenantClient('b').appConfig.create({ data: { key: 'admin_email', value: ' gerencia@cliente-b.es ' } });
      expect(await withTenantForTest('a', () => getOperatorEmail())).toBe('duena@cliente-a.es');
      expect(await withTenantForTest('b', () => getOperatorEmail())).toBe('gerencia@cliente-b.es');
    });
  });
});
