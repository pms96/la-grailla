import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey, parseMasterKey, registryKeyForHost, registryKeyForSecrets } from '@grailla/contracts';
import {
  L1_TTL_MS,
  LOOKUP_BURST,
  MAX_STALE_SERVE_MS,
  MAX_TRACKED_HOSTS,
  NEGATIVE_TTL_MS,
  RETRY_BACKOFF_MS,
  resetResolverStateForTests,
  resolveHost,
  setRegistryReaderForTests,
} from '@/lib/tenant/resolve';
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

describe('revisión de seguridad de M4: el registro no puede hacer servir el cliente equivocado', () => {
  it('un dominio que pasa de un cliente a otro no se compara con el `seq` del anterior (el seq es por suscripción)', async () => {
    await pub({ seq: 50 });
    expect(await resolveHost('a.cliente.es', NOW)).toMatchObject({ status: 'ok', ctx: { tenantId: A } });
    // El dominio se reasigna al cliente B, cuya suscripción empieza en 1.
    await publishTenant(reg, signer, { tenantId: B, hosts: ['a.cliente.es'], master, seq: 3, now: NOW });
    const r = await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2);
    expect(r).toMatchObject({ status: 'ok', stale: false, ctx: { tenantId: B } });
  });

  it('si el cliente nuevo del dominio no se puede verificar por completo, NUNCA se sirve el contexto del anterior', async () => {
    await pub({ seq: 50 });
    await resolveHost('a.cliente.es', NOW);
    // B toma el dominio pero sus secretos no están publicados todavía.
    await publishTenant(reg, signer, { tenantId: B, hosts: ['a.cliente.es'], master, seq: 3, now: NOW, skipSecrets: true });
    const r = await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2);
    expect(r.status).toBe('unavailable');
  });

  it('tras pasar por not_found, el dominio vuelve a resolverse con otro cliente sin quedarse bloqueado', async () => {
    await pub({ seq: 50 });
    await resolveHost('a.cliente.es', NOW);
    reg.data.delete(registryKeyForHost('a.cliente.es'));
    expect((await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2)).status).toBe('not_found');
    await publishTenant(reg, signer, { tenantId: B, hosts: ['a.cliente.es'], master, seq: 1, now: NOW });
    const r = await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2 + NEGATIVE_TTL_MS * 2);
    expect(r).toMatchObject({ status: 'ok', ctx: { tenantId: B } });
  });

  it('el replay sigue rechazándose para el MISMO cliente aunque cambie de dominio', async () => {
    await pub({ seq: 9, hosts: ['a.cliente.es', 'b.cliente.es'], modules: ['tienda', 'entradas'] });
    await resolveHost('a.cliente.es', NOW);
    await pub({ seq: 4, hosts: ['b.cliente.es'], modules: [] }); // snapshot antiguo del mismo cliente bajo otro dominio
    const r = await resolveHost('b.cliente.es', NOW);
    expect(r.status).toBe('unavailable');
  });
});

describe('revisión de seguridad de M4: modo degradado', () => {
  it('con el registro caído se sirve lo último bueno y NO se reintenta en cada petición', async () => {
    await pub();
    await resolveHost('a.cliente.es', NOW);
    reg.failWith = new Error('503 del registro');
    reg.calls.length = 0;
    const later = NOW + L1_TTL_MS * 2;
    for (let i = 0; i < 10; i++) expect(await resolveHost('a.cliente.es', later + i * 100)).toMatchObject({ status: 'ok', stale: true });
    expect(reg.calls.length).toBe(1);
    // Pasado el backoff se vuelve a intentar una vez.
    await resolveHost('a.cliente.es', later + RETRY_BACKOFF_MS * 2);
    expect(reg.calls.length).toBe(2);
  });

  it('sin caché y con el registro caído tampoco se martillea: el fallo se recuerda unos segundos', async () => {
    reg.failWith = new Error('caído');
    for (let i = 0; i < 10; i++) expect((await resolveHost('a.cliente.es', NOW + i * 100)).status).toBe('unavailable');
    expect(reg.calls.length).toBe(1);
  });

  it('servir obsoleto por una firma que no se puede verificar queda en el log (una suspensión no se aplicaría)', async () => {
    await pub();
    await resolveHost('a.cliente.es', NOW);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Suspensión firmada con un kid que este despliegue no conoce (rotación mal desplegada).
      const other = await makeSigner();
      await publishTenant(reg, { ...other, kid: 'desconocida' }, { tenantId: A, hosts: ['a.cliente.es'], master, seq: 2, status: 'SUSPENDED', now: NOW });
      const r = await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2);
      expect(r).toMatchObject({ status: 'ok', stale: true, ctx: { status: 'ACTIVE' } });
      expect(err.mock.calls.flat().join(' ')).toMatch(/unknown_kid/);
    } finally {
      err.mockRestore();
    }
  });
});

describe('revisión de seguridad de M4: hosts desconocidos', () => {
  it('la caché negativa tiene tope: un dominio comodín no puede inflar la memoria', async () => {
    let now = NOW;
    let n = 0;
    while (n < MAX_TRACKED_HOSTS + 500) {
      for (let i = 0; i < LOOKUP_BURST && n < MAX_TRACKED_HOSTS + 500; i++, n++) await resolveHost(`h${n}.comodin.es`, now);
      now += 6_000; // la cubeta se rellena entre ráfagas
    }
    const st = (globalThis as unknown as { __grailla_tenant_l1: { negative: Map<string, number> } }).__grailla_tenant_l1;
    expect(st.negative.size).toBeLessThanOrEqual(MAX_TRACKED_HOSTS);
  });

  it('las búsquedas de hosts sin caché están limitadas: una ráfaga no agota la cuota del registro', async () => {
    reg.calls.length = 0;
    const results = await Promise.all(Array.from({ length: LOOKUP_BURST * 3 }, (_, i) => resolveHost(`x${i}.comodin.es`, NOW)));
    expect(reg.calls.length).toBeLessThanOrEqual(LOOKUP_BURST);
    expect(results.filter((r) => r.status === 'unavailable').length).toBeGreaterThanOrEqual(LOOKUP_BURST * 2);
  });

  it('un host real con caché no se ve afectado por la limitación', async () => {
    await pub();
    await resolveHost('a.cliente.es', NOW);
    await Promise.all(Array.from({ length: LOOKUP_BURST * 2 }, (_, i) => resolveHost(`y${i}.comodin.es`, NOW)));
    expect((await resolveHost('a.cliente.es', NOW + L1_TTL_MS * 2)).status).toBe('ok');
  });
});
