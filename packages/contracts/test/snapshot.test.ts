import { describe, it, expect, beforeAll } from 'vitest';
import {
  CONTRACT_VERSION,
  RoutingRecordSchema,
  fromBase64Url,
  generateSigningKeyPair,
  newUlid,
  publicKeyOf,
  signSnapshot,
  toBase64Url,
  verifySnapshot,
  type RoutingRecord,
  type SnapshotBody,
} from '../src';

const NOW = 1_800_000_000_000;
const TENANT = '01HF7YAT00ABCDEFGHJKMNPQRS';

function record(over: Partial<RoutingRecord> = {}): RoutingRecord {
  return {
    tenantId: TENANT,
    product: 'grailla',
    cell: 'shared-1',
    status: 'ACTIVE',
    modules: ['tienda', 'entradas'],
    license: { phase: 'ACTIVE', nextPhaseChangeAt: null },
    primaryDomain: 'www.cliente.es',
    domains: ['www.cliente.es', 'cliente.es'],
    schemaVersion: '20260930110333_add_ingreso_model',
    epoch: 0,
    ...over,
  };
}
const body = (over: Partial<SnapshotBody> = {}): SnapshotBody => ({
  contractVersion: CONTRACT_VERSION,
  seq: 5,
  iat: NOW,
  staleUntil: NOW + 86_400_000,
  record: record(),
  ...over,
});

let priv = '';
let pub = '';
beforeAll(async () => {
  ({ privateKey: priv, publicKey: pub } = await generateSigningKeyPair());
});

describe('RoutingRecordSchema', () => {
  it('acepta un registro válido', () => {
    expect(RoutingRecordSchema.safeParse(record()).success).toBe(true);
  });

  it('rechaza lo que no es un ULID, un dominio no normalizado o un primario fuera de la lista', () => {
    expect(RoutingRecordSchema.safeParse(record({ tenantId: 'legacy' })).success).toBe(false);
    expect(RoutingRecordSchema.safeParse(record({ domains: ['WWW.Cliente.es'], primaryDomain: 'WWW.Cliente.es' })).success).toBe(false);
    expect(RoutingRecordSchema.safeParse(record({ primaryDomain: 'otro.es' })).success).toBe(false);
    expect(RoutingRecordSchema.safeParse(record({ domains: ['a.es', 'a.es'], primaryDomain: 'a.es' })).success).toBe(false);
  });

  it('una fase de licencia desconocida invalida el registro (fail-closed)', () => {
    const bad = { ...record(), license: { phase: 'FREE_FOREVER', nextPhaseChangeAt: null } };
    expect(RoutingRecordSchema.safeParse(bad).success).toBe(false);
  });

  it('un módulo desconocido NO invalida el registro (se ignorará al leer)', () => {
    expect(RoutingRecordSchema.safeParse(record({ modules: ['tienda', 'modulo-del-futuro'] })).success).toBe(true);
  });

  it('ignora campos nuevos (compatibilidad hacia delante) y no deja pasar secretos al lector', () => {
    const parsed = RoutingRecordSchema.parse({ ...record(), databaseUrl: 'postgres://secreto', nuevoCampo: 1 });
    expect(parsed).not.toHaveProperty('databaseUrl');
    expect(parsed).not.toHaveProperty('nuevoCampo');
  });
});

describe('snapshot firmado', () => {
  it('firma y verifica de ida y vuelta', async () => {
    const env = await signSnapshot(body(), { kid: 'k1', privateKey: priv });
    const res = await verifySnapshot(env, { keys: { k1: pub }, now: NOW });
    expect(res).toMatchObject({ ok: true, stale: false });
    if (res.ok) expect(res.body.record.tenantId).toBe(TENANT);
  });

  it('el JSON puede viajar por la red (Redis, Edge Config) sin perder validez', async () => {
    const env = await signSnapshot(body(), { kid: 'k1', privateKey: priv });
    const res = await verifySnapshot(JSON.parse(JSON.stringify(env)), { keys: { k1: pub }, now: NOW });
    expect(res.ok).toBe(true);
  });

  it('rechaza un payload alterado', async () => {
    const env = await signSnapshot(body(), { kid: 'k1', privateKey: priv });
    const tampered = { ...env, payload: env.payload.replace('"epoch":0', '"epoch":1') };
    expect(tampered.payload).not.toBe(env.payload);
    expect(await verifySnapshot(tampered, { keys: { k1: pub }, now: NOW })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rechaza cambiar el kid (está dentro de lo firmado)', async () => {
    const other = await generateSigningKeyPair();
    const env = await signSnapshot(body(), { kid: 'k1', privateKey: priv });
    const res = await verifySnapshot({ ...env, kid: 'k2' }, { keys: { k1: pub, k2: pub }, now: NOW });
    expect(res).toEqual({ ok: false, reason: 'bad_signature' });
    expect(other.publicKey).not.toBe(pub);
  });

  it('rechaza una firma hecha con otra clave y un kid desconocido', async () => {
    const other = await generateSigningKeyPair();
    const env = await signSnapshot(body(), { kid: 'k1', privateKey: other.privateKey });
    expect(await verifySnapshot(env, { keys: { k1: pub }, now: NOW })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySnapshot(env, { keys: { otra: pub }, now: NOW })).toEqual({ ok: false, reason: 'unknown_kid' });
    expect(await verifySnapshot(env, { keys: {}, now: NOW })).toEqual({ ok: false, reason: 'unknown_kid' });
  });

  it('un kid como "__proto__" o "constructor" no se resuelve por la cadena de prototipos', async () => {
    const env = await signSnapshot(body(), { kid: 'k1', privateKey: priv });
    for (const kid of ['constructor', 'toString', '__proto__']) {
      expect(await verifySnapshot({ ...env, kid }, { keys: {}, now: NOW })).toEqual({ ok: false, reason: 'unknown_kid' });
    }
  });

  it('permite rotar claves: la vieja y la nueva conviven en el llavero', async () => {
    const next = await generateSigningKeyPair();
    const oldEnv = await signSnapshot(body(), { kid: 'k1', privateKey: priv });
    const newEnv = await signSnapshot(body({ seq: 6 }), { kid: 'k2', privateKey: next.privateKey });
    const keys = { k1: pub, k2: next.publicKey };
    expect((await verifySnapshot(oldEnv, { keys, now: NOW })).ok).toBe(true);
    expect((await verifySnapshot(newEnv, { keys, now: NOW })).ok).toBe(true);
  });

  it('marca como obsoleto (no como inválido) un snapshot pasado su staleUntil', async () => {
    const env = await signSnapshot(body(), { kid: 'k1', privateKey: priv });
    const res = await verifySnapshot(env, { keys: { k1: pub }, now: NOW + 86_400_001 });
    expect(res).toMatchObject({ ok: true, stale: true });
  });

  it('rechaza un snapshot más viejo que el último visto (replay) y acepta el mismo seq', async () => {
    const env = await signSnapshot(body({ seq: 5 }), { kid: 'k1', privateKey: priv });
    expect(await verifySnapshot(env, { keys: { k1: pub }, now: NOW, lastSeq: 6 })).toEqual({ ok: false, reason: 'replay' });
    expect((await verifySnapshot(env, { keys: { k1: pub }, now: NOW, lastSeq: 5 })).ok).toBe(true);
  });

  it('rechaza un contrato más nuevo que el soportado', async () => {
    const env = await signSnapshot(body({ contractVersion: CONTRACT_VERSION + 1 }), { kid: 'k1', privateKey: priv });
    expect(await verifySnapshot(env, { keys: { k1: pub }, now: NOW })).toEqual({ ok: false, reason: 'unsupported_contract' });
    expect((await verifySnapshot(env, { keys: { k1: pub }, now: NOW, supportedContractVersion: CONTRACT_VERSION + 1 })).ok).toBe(true);
  });

  it.each([null, undefined, 'texto', 42, {}, { kid: 'k1' }, { kid: 'k1', payload: '{}', sig: 'x' }])('entrada mal formada %j → malformed', async (input) => {
    expect(await verifySnapshot(input, { keys: { k1: pub }, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('firmado válido pero con un registro inválido dentro → malformed (firma de un payload que no cumple el contrato)', async () => {
    // Se firma a mano saltándose signSnapshot para simular un panel con un bug.
    const payload = JSON.stringify({ ...body(), record: { ...record(), tenantId: 'no-es-ulid' } });
    const key = await crypto.subtle.importKey('pkcs8', fromBase64Url(priv), 'Ed25519', false, ['sign']);
    const msg = new TextEncoder().encode(`grailla-snapshot-v1\nk1\n${payload}`);
    const sig = toBase64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, msg)));
    expect(await verifySnapshot({ kid: 'k1', payload, sig }, { keys: { k1: pub }, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('signSnapshot se niega a firmar un registro inválido', async () => {
    await expect(signSnapshot(body({ record: record({ tenantId: 'x' }) }), { kid: 'k1', privateKey: priv })).rejects.toThrow();
    await expect(signSnapshot(body(), { kid: 'k 1', privateKey: priv })).rejects.toThrow(/kid/);
  });

  it('publicKeyOf devuelve la misma clave pública que generateSigningKeyPair', async () => {
    expect(await publicKeyOf(priv)).toBe(pub);
  });

  it('newUlid produce tenantIds aceptados por el contrato', () => {
    expect(RoutingRecordSchema.safeParse(record({ tenantId: newUlid() })).success).toBe(true);
  });
});

// Vector congelado: una clave fija produce SIEMPRE la misma firma (Ed25519 es
// determinista). Si este test falla, cambió el formato del mensaje firmado o
// la serialización, y los snapshots ya publicados dejarían de verificar.
describe('vector dorado', () => {
  const SEED_PKCS8 = toBase64Url(
    new Uint8Array([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
      ...Array.from({ length: 32 }, (_, i) => i + 1),
    ])
  );

  it('la firma de un cuerpo fijo no cambia', async () => {
    const env = await signSnapshot(body(), { kid: 'golden', privateKey: SEED_PKCS8 });
    expect(env.payload).toBe(
      '{"contractVersion":1,"seq":5,"iat":1800000000000,"staleUntil":1800086400000,"record":{"tenantId":"01HF7YAT00ABCDEFGHJKMNPQRS","product":"grailla","cell":"shared-1","status":"ACTIVE","modules":["tienda","entradas"],"license":{"phase":"ACTIVE","nextPhaseChangeAt":null},"primaryDomain":"www.cliente.es","domains":["www.cliente.es","cliente.es"],"schemaVersion":"20260930110333_add_ingreso_model","epoch":0}}'
    );
    expect(env.sig).toBe('sulTb8i2e4p8-6IVfI2Z3saQO8ZzPsb7AzXUdAduv8hq8lTHfCT-sM4w4wKHAUw0wH1-sy5wfPWwwiGeDaAFDQ');
    const res = await verifySnapshot(env, { keys: { golden: await publicKeyOf(SEED_PKCS8) }, now: NOW });
    expect(res.ok).toBe(true);
  });
});
