import { beforeAll, describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  DB_URL_POOLED_FIELD,
  generateMasterKey,
  generateSigningKeyPair,
  parseMasterKey,
  sealSecret,
  signSecretsSnapshot,
  signSnapshot,
  verifySecretsSnapshot,
  verifySnapshot,
  type RoutingRecord,
} from '../src';

/* El anti-replay del front se basa en `iat` (cuándo firmó el panel) y no en `seq`: al restaurar la BD de control el `seq` retrocede y cada
 * front rechazaba los snapshots buenos hasta 6 h. Y un snapshot demasiado viejo caduca aunque la firma sea válida. */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const HOST = 'www.cliente.es';
const TENANT = '01HF7YAT00ABCDEFGHJKMNPQRS';
const master = parseMasterKey(generateMasterKey());
let priv = '';
let pub = '';

const record = (): RoutingRecord => ({
  tenantId: TENANT,
  product: 'grailla',
  cell: 'shared-1',
  status: 'ACTIVE',
  modules: ['tienda'],
  license: { phase: 'ACTIVE', nextPhaseChangeAt: null },
  primaryDomain: HOST,
  domains: [HOST],
  schemaVersion: '20260930110333_add_ingreso_model',
  epoch: 0,
});
const routing = (over: { seq?: number; iat?: number } = {}) =>
  signSnapshot({ contractVersion: CONTRACT_VERSION, seq: over.seq ?? 5, iat: over.iat ?? NOW, staleUntil: NOW + DAY, record: record() }, { kid: 'k1', privateKey: priv });
const secrets = async (over: { seq?: number; iat?: number } = {}) =>
  signSecretsSnapshot(
    {
      contractVersion: CONTRACT_VERSION,
      seq: over.seq ?? 3,
      iat: over.iat ?? NOW,
      tenantId: TENANT,
      product: 'grailla',
      dbUrlPooledEnc: await sealSecret('postgresql://a', { kid: 'm1', tenantId: TENANT, field: DB_URL_POOLED_FIELD }, master),
      dbUrlDirectEnc: await sealSecret('postgresql://b', { kid: 'm1', tenantId: TENANT, field: 'db_url_direct' }, master),
    },
    { kid: 'k1', privateKey: priv }
  );

beforeAll(async () => {
  ({ privateKey: priv, publicKey: pub } = await generateSigningKeyPair());
});

const v = (env: unknown, extra: Record<string, unknown> = {}) => verifySnapshot(env, { keys: { k1: pub }, host: HOST, now: NOW, ...extra });
const vs = (env: unknown, extra: Record<string, unknown> = {}) => verifySecretsSnapshot(env, { keys: { k1: pub }, tenantId: TENANT, product: 'grailla', ...extra });

describe('snapshot de enrutado: anti-replay por iat', () => {
  it('rechaza uno firmado ANTES que el último aceptado, y acepta el mismo instante o uno posterior', async () => {
    const env = await routing({ iat: NOW });
    expect(await v(env, { lastIat: NOW + 1 })).toEqual({ ok: false, reason: 'replay' });
    expect((await v(env, { lastIat: NOW })).ok).toBe(true);
    expect((await v(env, { lastIat: NOW - 1 })).ok).toBe(true);
    expect((await v(env, { lastIat: null })).ok).toBe(true);
  });

  it('tras restaurar el panel el `seq` retrocede pero el `iat` es nuevo: se acepta (el `seq` ya no decide)', async () => {
    const restored = await routing({ seq: 3, iat: NOW + 60_000 }); // la BD de control volvió a un `seq` antiguo y republicó
    expect((await v(restored, { lastIat: NOW, now: NOW + 60_000 })).ok).toBe(true);
  });

  it('un snapshot antiguo repuesto (con `seq` alto) sigue rechazándose por su `iat`', async () => {
    const old = await routing({ seq: 999, iat: NOW - 10 * DAY });
    expect(await v(old, { lastIat: NOW })).toEqual({ ok: false, reason: 'replay' });
  });
});

describe('snapshot de enrutado: caducidad dura', () => {
  it('rechaza uno firmado hace más de maxAgeMs aunque la firma sea válida', async () => {
    const env = await routing({ iat: NOW - 31 * DAY });
    expect(await v(env, { maxAgeMs: 30 * DAY })).toEqual({ ok: false, reason: 'expired' });
  });

  it('el límite es exacto: justo en el plazo vale, un milisegundo más no', async () => {
    expect((await v(await routing({ iat: NOW - 30 * DAY }), { maxAgeMs: 30 * DAY })).ok).toBe(true);
    expect(await v(await routing({ iat: NOW - 30 * DAY - 1 }), { maxAgeMs: 30 * DAY })).toEqual({ ok: false, reason: 'expired' });
  });

  it('sin maxAgeMs no caduca (compatibilidad con quien no lo pide)', async () => {
    expect((await v(await routing({ iat: NOW - 400 * DAY }))).ok).toBe(true);
  });
});

describe('snapshot de secretos: lo mismo', () => {
  it('anti-replay por iat y no por seq', async () => {
    const old = await secrets({ seq: 999, iat: NOW - DAY });
    expect(await vs(old, { lastIat: NOW })).toEqual({ ok: false, reason: 'replay' });
    const restored = await secrets({ seq: 1, iat: NOW + DAY });
    expect((await vs(restored, { lastIat: NOW })).ok).toBe(true);
  });

  it('caducidad dura (necesita `now`)', async () => {
    const env = await secrets({ iat: NOW - 31 * DAY });
    expect(await vs(env, { maxAgeMs: 30 * DAY, now: NOW })).toEqual({ ok: false, reason: 'expired' });
    expect((await vs(env, { maxAgeMs: 30 * DAY })).ok).toBe(true); // sin `now` no se puede medir: compatibilidad
  });
});
