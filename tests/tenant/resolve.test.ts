import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey, parseMasterKey, registryKeyForHost, registryKeyForSecrets } from '@grailla/contracts';
import { L1_TTL_MS, MAX_STALE_SERVE_MS, NEGATIVE_TTL_MS, resetResolverStateForTests, resolveHost, setRegistryReaderForTests } from '@/lib/tenant/resolve';
import { FakeRegistry, makeSigner, publishTenant, type Signer } from '../helpers/registry';

const A = '01HF7YAT00AAAAAAAAAAAAAAAA';
const B = '01HF7YAT00BBBBBBBBBBBBBBBB';
const master = parseMasterKey(generateMasterKey());
let reg: FakeRegistry;
let signer: Signer;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  signer = await makeSigner();
  reg = new FakeRegistry();
  vi.stubEnv('SNAPSHOT_PUBKEYS', JSON.stringify({ [signer.kid]: signer.publicKey }));
  resetResolverStateForTests();
  setRegistryReaderForTests(reg);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setRegistryReaderForTests(null);
  resetResolverStateForTests();
});

const pub = (over = {}) => publishTenant(reg, signer, { tenantId: A, hosts: ['a.cliente.es', 'www.a.cliente.es'], master, modules: ['tienda'], now: NOW, ...over });

describe('resolver un Host', () => {
  it('devuelve el contexto del cliente con los secretos sellados (no en claro)', async () => {
    await pub();
    const r = await resolveHost('a.cliente.es', NOW);
    expect(r).toMatchObject({ status: 'ok', stale: false, ctx: { tenantId: A, product: 'grailla', primaryDomain: 'a.cliente.es', modules: ['tienda'], status: 'ACTIVE', epoch: 0 } });
    if (r.status !== 'ok') return;
    expect(r.ctx.db.pooledEnc.startsWith('enc:v2:tk:')).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('normaliza el host (mayúsculas, puerto) y rechaza lo que no es un dominio sin tocar el registro', async () => {
    await pub();
    expect((await resolveHost('A.Cliente.ES:443', NOW)).status).toBe('ok');
    reg.calls.length = 0;
    for (const bad of ['', 'evil.com/x', 'a b.es', '1.2.3.4', 'localhost']) expect(await resolveHost(bad, NOW)).toEqual({ status: 'not_found' });
    expect(reg.calls).toEqual([]);
  });

  it('un host que no está en el registro da not_found', async () => {
    expect(await resolveHost('nadie.es', NOW)).toEqual({ status: 'not_found' });
  });
});

describe('caché L1', () => {
  it('sirve de la caché dentro del TTL y vuelve a leer pasado el TTL', async () => {
    await pub();
    await resolveHost('a.cliente.es', NOW);
    const afterFirst = reg.calls.length;
    await resolveHost('a.cliente.es', NOW + 1000);
    expect(reg.calls.length).toBe(afterFirst);
    await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 1.5);
    expect(reg.calls.length).toBeGreaterThan(afterFirst);
  });

  it('un host desconocido se cachea en negativo: repetirlo no machaca el registro', async () => {
    await resolveHost('nadie.es', NOW);
    await resolveHost('nadie.es', NOW + 100);
    await resolveHost('nadie.es', NOW + 200);
    expect(reg.calls.filter((k) => k === registryKeyForHost('nadie.es'))).toHaveLength(1);
    await resolveHost('nadie.es', NOW + NEGATIVE_TTL_MS * 1.5);
    expect(reg.calls.filter((k) => k === registryKeyForHost('nadie.es'))).toHaveLength(2);
  });

  it('una ráfaga simultánea al mismo host cuesta una sola lectura (single-flight)', async () => {
    await pub();
    const results = await Promise.all(Array.from({ length: 25 }, () => resolveHost('a.cliente.es', NOW)));
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(reg.calls).toHaveLength(2); // enrutado + secretos, una vez
  });
});

describe('el registro es un dato no fiable', () => {
  it('rechaza el snapshot de un cliente copiado bajo el dominio de otro', async () => {
    await pub();
    reg.data.set(registryKeyForHost('b.cliente.es'), reg.data.get(registryKeyForHost('a.cliente.es'))!);
    const r = await resolveHost('b.cliente.es', NOW);
    expect(r.status).toBe('unavailable');
    expect(JSON.stringify(r)).toContain('host_mismatch');
  });

  it('rechaza una firma manipulada o hecha con otra clave', async () => {
    await pub();
    const raw = JSON.parse(reg.data.get(registryKeyForHost('a.cliente.es'))!);
    reg.data.set(registryKeyForHost('a.cliente.es'), JSON.stringify({ ...raw, payload: raw.payload.replace('"tienda"', '"contabilidad"') }));
    expect((await resolveHost('a.cliente.es', NOW)).status).toBe('unavailable');

    resetResolverStateForTests();
    const other = await makeSigner();
    await publishTenant(reg, other, { tenantId: A, hosts: ['a.cliente.es'], master, now: NOW });
    expect((await resolveHost('a.cliente.es', NOW)).status).toBe('unavailable');
  });

  it('sin secretos publicados no hay cliente: sin conexión no se puede servir', async () => {
    await pub({ skipSecrets: true });
    expect(JSON.stringify(await resolveHost('a.cliente.es', NOW))).toContain('no hay secretos');
  });

  it('un secreto firmado para OTRO cliente no sirve', async () => {
    await pub();
    await publishTenant(reg, signer, { tenantId: B, hosts: ['b.cliente.es'], master, now: NOW });
    reg.data.set(registryKeyForSecrets(A, 'grailla'), reg.data.get(registryKeyForSecrets(B, 'grailla'))!);
    expect(JSON.stringify(await resolveHost('a.cliente.es', NOW))).toContain('tenant_mismatch');
  });

  it('rechaza un contrato más nuevo que el soportado y un producto distinto', async () => {
    await pub({ contractVersion: 99 });
    expect(JSON.stringify(await resolveHost('a.cliente.es', NOW))).toContain('unsupported_contract');
    resetResolverStateForTests();
    await pub({ contractVersion: 1 });
    vi.stubEnv('PLATFORM_PRODUCT', 'otro-producto');
    expect(JSON.stringify(await resolveHost('a.cliente.es', NOW))).toContain('product_mismatch');
  });
});

describe('caída o manipulación del registro: se sigue sirviendo lo último bueno', () => {
  it('si el registro falla, sirve el último valor bueno como obsoleto, durante un tiempo acotado', async () => {
    await pub();
    expect((await resolveHost('a.cliente.es', NOW)).status).toBe('ok');
    reg.failWith = new Error('503 del registro');
    const later = NOW + L1_TTL_MS * 2;
    expect(await resolveHost('a.cliente.es', later)).toMatchObject({ status: 'ok', stale: true });
    expect((await resolveHost('a.cliente.es', NOW + MAX_STALE_SERVE_MS + 1000)).status).toBe('unavailable');
  });

  it('si el registro está caído y no hay nada en caché, no se inventa nada', async () => {
    reg.failWith = new Error('caído');
    expect((await resolveHost('a.cliente.es', NOW)).status).toBe('unavailable');
  });

  it('un valor manipulado en el almacén no tumba una web que ya se estaba sirviendo', async () => {
    await pub();
    await resolveHost('a.cliente.es', NOW);
    reg.data.set(registryKeyForHost('a.cliente.es'), '{"basura":true}');
    const r = await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2);
    expect(r).toMatchObject({ status: 'ok', stale: true, ctx: { tenantId: A, modules: ['tienda'] } });
  });

  it('un snapshot más viejo (replay) no degrada al cliente: se conserva lo último visto', async () => {
    await pub({ seq: 5, modules: ['tienda', 'entradas'] });
    await resolveHost('a.cliente.es', NOW);
    await pub({ seq: 3, modules: [] }); // alguien repone un snapshot antiguo, con firma válida
    const r = await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2);
    expect(r).toMatchObject({ status: 'ok', ctx: { modules: ['tienda', 'entradas'] } });
  });

  it('un dominio liberado (ya no está en el registro) deja de servirse aunque hubiera caché', async () => {
    await pub();
    await resolveHost('a.cliente.es', NOW);
    reg.data.delete(registryKeyForHost('a.cliente.es'));
    expect(await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2)).toEqual({ status: 'not_found' });
  });

  it('un cambio publicado (suspensión, módulos, época) llega al caducar la caché', async () => {
    await pub({ seq: 1 });
    await resolveHost('a.cliente.es', NOW);
    await pub({ seq: 2, status: 'SUSPENDED', epoch: 4, modules: [] });
    const r = await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2);
    expect(r).toMatchObject({ status: 'ok', ctx: { status: 'SUSPENDED', epoch: 4, modules: [] } });
  });
});
