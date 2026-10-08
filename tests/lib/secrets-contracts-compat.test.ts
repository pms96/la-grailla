import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { decryptSecret, encryptSecretV2, registerKeyProvider } from '@/lib/secrets';
import { generateMasterKey, openSecret, parseMasterKey, sealSecret } from '@grailla/contracts';

// El panel escribe con @grailla/contracts (WebCrypto) y el front lee con
// lib/secrets.ts (node:crypto). Si estos dos dejan de entenderse, las URLs de
// BD de los clientes quedarían ilegibles: este test es la red de seguridad.

const masterText = generateMasterKey();
const master = parseMasterKey(masterText);
const tenantId = '01HF7YAT00ABCDEFGHJKMNPQRS';

beforeAll(() => {
  registerKeyProvider('compat', {
    getKey: ({ tenantId: t, kid }) =>
      Buffer.from(crypto.hkdfSync('sha256', Buffer.from(master), Buffer.from(t, 'utf8'), Buffer.from(`grailla-secrets-v2:${kid}`, 'utf8'), 32)),
  });
});

describe('enc:v2 entre el panel (contracts) y el front (lib/secrets)', () => {
  it('lo que sella el panel lo abre el front', async () => {
    const sealed = await sealSecret('postgresql://u:p@host/db', { kid: 'compat', tenantId, field: 'database_url_pooled' }, master);
    expect(decryptSecret(sealed, { tenantId, configKey: 'database_url_pooled' })).toBe('postgresql://u:p@host/db');
  });

  it('lo que sella el front lo abre el panel', async () => {
    const sealed = encryptSecretV2('otro-secreto', { kid: 'compat', tenantId, configKey: 'sumup_api_key' });
    expect(await openSecret(sealed, { tenantId, field: 'sumup_api_key' }, master)).toBe('otro-secreto');
  });

  it('el front tampoco abre un valor del panel con otro campo', async () => {
    const sealed = await sealSecret('x', { kid: 'compat', tenantId, field: 'a' }, master);
    expect(() => decryptSecret(sealed, { tenantId, configKey: 'b' })).toThrow();
  });
});
