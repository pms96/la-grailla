import { describe, it, expect, beforeAll } from 'vitest';
import {
  CONTRACT_VERSION,
  DB_URL_POOLED_FIELD,
  deriveInstallationSecret,
  generateMasterKey,
  generateSigningKeyPair,
  parseMasterKey,
  registryKeyForSecrets,
  sealSecret,
  signSecretsSnapshot,
  signSnapshot,
  verifySecretsSnapshot,
  verifySnapshot,
  type RoutingRecord,
} from '../src';

const TENANT = '01HF7YAT00ABCDEFGHJKMNPQRS';
const OTHER = '01HF7YAT00ABCDEFGHJKMNPQRT';
const master = parseMasterKey(generateMasterKey());
let priv = '';
let pub = '';
let body: Parameters<typeof signSecretsSnapshot>[0];

beforeAll(async () => {
  ({ privateKey: priv, publicKey: pub } = await generateSigningKeyPair());
  body = {
    contractVersion: CONTRACT_VERSION,
    seq: 3,
    iat: 1_800_000_000_000,
    tenantId: TENANT,
    product: 'grailla',
    dbUrlPooledEnc: await sealSecret('postgresql://a', { kid: 'm1', tenantId: TENANT, field: DB_URL_POOLED_FIELD }, master),
    dbUrlDirectEnc: await sealSecret('postgresql://b', { kid: 'm1', tenantId: TENANT, field: 'db_url_direct' }, master),
  };
});

const opts = () => ({ keys: { k1: pub }, tenantId: TENANT, product: 'grailla' });

describe('snapshot de secretos', () => {
  it('firma y verifica de ida y vuelta (también tras viajar como JSON)', async () => {
    const env = await signSecretsSnapshot(body, { kid: 'k1', privateKey: priv });
    const res = await verifySecretsSnapshot(JSON.parse(JSON.stringify(env)), opts());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body.dbUrlPooledEnc.startsWith('enc:v2:m1:')).toBe(true);
  });

  it('no contiene ninguna URL en claro', async () => {
    const env = await signSecretsSnapshot(body, { kid: 'k1', privateKey: priv });
    expect(env.payload).not.toContain('postgresql://');
  });

  it('rechaza un tenant o un producto distinto (copia bajo otra clave del almacén)', async () => {
    const env = await signSecretsSnapshot(body, { kid: 'k1', privateKey: priv });
    expect(await verifySecretsSnapshot(env, { ...opts(), tenantId: OTHER })).toEqual({ ok: false, reason: 'tenant_mismatch' });
    expect(await verifySecretsSnapshot(env, { ...opts(), product: 'otro' })).toEqual({ ok: false, reason: 'product_mismatch' });
  });

  it('rechaza replay, contrato nuevo, kid desconocido, firma ajena y payload alterado', async () => {
    const env = await signSecretsSnapshot(body, { kid: 'k1', privateKey: priv });
    expect(await verifySecretsSnapshot(env, { ...opts(), lastSeq: 4 })).toEqual({ ok: false, reason: 'replay' });
    expect((await verifySecretsSnapshot(env, { ...opts(), lastSeq: 3 })).ok).toBe(true);
    const future = await signSecretsSnapshot({ ...body, contractVersion: CONTRACT_VERSION + 1 }, { kid: 'k1', privateKey: priv });
    expect(await verifySecretsSnapshot(future, opts())).toEqual({ ok: false, reason: 'unsupported_contract' });
    expect(await verifySecretsSnapshot(env, { ...opts(), keys: {} })).toEqual({ ok: false, reason: 'unknown_kid' });
    const other = await generateSigningKeyPair();
    const forged = await signSecretsSnapshot(body, { kid: 'k1', privateKey: other.privateKey });
    expect(await verifySecretsSnapshot(forged, opts())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySecretsSnapshot({ ...env, payload: env.payload.replace('"seq":3', '"seq":9') }, opts())).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('un snapshot de ENRUTADO no sirve como snapshot de secretos ni al revés (etiquetas distintas)', async () => {
    const record: RoutingRecord = {
      tenantId: TENANT, product: 'grailla', cell: 'shared-1', status: 'ACTIVE', modules: [], license: { phase: 'ACTIVE', nextPhaseChangeAt: null },
      primaryDomain: 'a.cliente.es', domains: ['a.cliente.es'], schemaVersion: null, epoch: 0,
    };
    const routing = await signSnapshot({ contractVersion: 1, seq: 1, iat: 1, staleUntil: 2, record }, { kid: 'k1', privateKey: priv });
    expect((await verifySecretsSnapshot(routing, opts())).ok).toBe(false);
    const secrets = await signSecretsSnapshot(body, { kid: 'k1', privateKey: priv });
    expect((await verifySnapshot(secrets, { keys: { k1: pub }, host: 'a.cliente.es', now: 1 })).ok).toBe(false);
  });

  it('rechaza valores que no estén sellados (URL en claro)', async () => {
    await expect(signSecretsSnapshot({ ...body, dbUrlPooledEnc: 'postgresql://claro' }, { kid: 'k1', privateKey: priv })).rejects.toThrow();
  });

  it('la clave del almacén es estable y valida tenant y producto', () => {
    expect(registryKeyForSecrets(TENANT, 'grailla')).toBe(`s:${TENANT}:grailla`);
    expect(() => registryKeyForSecrets('no-ulid', 'grailla')).toThrow();
    expect(() => registryKeyForSecrets(TENANT, 'Mala Clave')).toThrow();
  });
});

describe('secreto de instalación por cliente', () => {
  it('es estable y distinto por cliente, época y uso', async () => {
    const a = await deriveInstallationSecret(master, TENANT, 0, 'session');
    expect(a).toBe(await deriveInstallationSecret(master, TENANT, 0, 'session'));
    expect(a).not.toBe(await deriveInstallationSecret(master, OTHER, 0, 'session'));
    expect(a).not.toBe(await deriveInstallationSecret(master, TENANT, 1, 'session'));
    expect(a).not.toBe(await deriveInstallationSecret(master, TENANT, 0, 'access'));
    expect(a).not.toBe(await deriveInstallationSecret(parseMasterKey(generateMasterKey()), TENANT, 0, 'session'));
    expect(a).toHaveLength(43); // 32 bytes en base64url
  });
});
