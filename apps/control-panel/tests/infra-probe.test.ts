import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatReport, hasFailures, percentile, probeCron, probeDatabase, probeHosts, probeRegistry, scrub, type Check } from '../lib/ops/infra-probe';
import { createScratchDb, dropScratchDb } from './scratch-db';

const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('utilidades del informe', () => {
  it('percentile usa el rango más cercano', () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([], 50)).toBeNaN();
  });

  it('scrub quita URLs de conexión y secretos conocidos, y formatReport nunca los deja pasar', () => {
    const text = 'falló postgresql://u:clave@host/db y el token tok_secreto_123';
    expect(scrub(text, ['tok_secreto_123'])).toBe('falló postgresql://[oculto] y el token [oculto]');
    const out = formatReport([{ id: 'x', status: 'fail', title: 'token tok_secreto_123', detail: 'postgresql://u:clave@host/db' }], ['tok_secreto_123']);
    expect(out).not.toContain('tok_secreto_123');
    expect(out).not.toContain('clave');
  });

  it('hasFailures solo cuenta los fallos (avisos e informativos no)', () => {
    expect(hasFailures([{ id: 'a', status: 'warn', title: '' }, { id: 'b', status: 'info', title: '' }])).toBe(false);
    expect(hasFailures([{ id: 'a', status: 'fail', title: '' }])).toBe(true);
  });
});

/** Un Upstash en memoria con dos tokens; `readOnlyCanWrite` simula una consola mal configurada. */
function fakeUpstash(opts: { readOnlyCanWrite?: boolean; extraKeys?: string[] } = {}) {
  const data = new Map<string, string>((opts.extraKeys ?? []).map((k) => [k, 'x']));
  const fetch = async (_url: string, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    if (token !== 'rw-token' && token !== 'ro-token') return json(401, { error: 'Unauthorized' });
    const [op, key, value] = JSON.parse(String(init?.body)) as string[];
    const write = ['SET', 'DEL'].includes(op.toUpperCase());
    if (write && token === 'ro-token' && !opts.readOnlyCanWrite) return json(400, { error: `NOPERM no permissions to run '${op.toLowerCase()}'` });
    switch (op.toUpperCase()) {
      case 'SET':
        data.set(key, value);
        return json(200, { result: 'OK' });
      case 'GET':
        return json(200, { result: data.get(key) ?? null });
      case 'DEL':
        return json(200, { result: data.delete(key) ? 1 : 0 });
      case 'SCAN':
        return json(200, { result: ['0', [...data.keys()]] });
    }
    return json(400, { error: 'unknown' });
  };
  return { fetch, data };
}

describe('probeRegistry', () => {
  const base = { url: 'https://registro.example.upstash.io', writeToken: 'rw-token', readOnlyToken: 'ro-token', samples: 3 };

  it('pasa con un token de solo lectura que de verdad no escribe, y no deja la clave de prueba', async () => {
    const up = fakeUpstash({ extraKeys: ['h:www.a.es', 's:01ABC:tienda'] });
    const checks = await probeRegistry({ ...base, fetch: up.fetch });
    expect(hasFailures(checks)).toBe(false);
    expect(byId(checks, 'reg.read-only-write')?.status).toBe('pass');
    expect(byId(checks, 'reg.foreign-keys')?.status).toBe('pass');
    expect([...up.data.keys()].some((k) => k.startsWith('__probe__:'))).toBe(false);
  });

  it('falla si el token «de solo lectura» puede escribir, y aun así limpia', async () => {
    const up = fakeUpstash({ readOnlyCanWrite: true });
    const checks = await probeRegistry({ ...base, fetch: up.fetch });
    expect(byId(checks, 'reg.read-only-write')?.status).toBe('fail');
    expect([...up.data.keys()].some((k) => k.startsWith('__probe__:'))).toBe(false);
  });

  it('avisa si la base tiene claves ajenas (una base por entorno)', async () => {
    const checks = await probeRegistry({ ...base, fetch: fakeUpstash({ extraKeys: ['sesion:abc'] }).fetch });
    expect(byId(checks, 'reg.foreign-keys')?.status).toBe('warn');
  });

  it('falla con un registro por http fuera de loopback y se detiene si el token de escritura no escribe', async () => {
    const insecure = await probeRegistry({ ...base, url: 'http://registro.example.com', fetch: fakeUpstash().fetch });
    expect(byId(insecure, 'reg.https')?.status).toBe('fail');
    const bad = await probeRegistry({ ...base, writeToken: 'otro', fetch: fakeUpstash().fetch });
    expect(byId(bad, 'reg.write')?.status).toBe('fail');
    expect(byId(bad, 'reg.read-only-read')).toBeUndefined();
  });
});

/** Dos clientes servidos por el mismo despliegue. `contaminate` hace que la 2ª petición de A devuelva la página de B (caché que mezcla Hosts). */
function fakeHosts(opts: { contaminate?: boolean; healthLeak?: boolean; foreignSitemap?: boolean; sameTitle?: boolean } = {}) {
  const hits = new Map<string, number>();
  return async (input: string) => {
    const u = new URL(input);
    const brand = u.host.startsWith('a.') ? 'Casa A' : u.host.startsWith('b.') ? 'Casa B' : null;
    if (!brand) return new Response('no configurado', { status: 404 });
    const n = (hits.get(input) ?? 0) + 1;
    hits.set(input, n);
    const shownBrand = opts.contaminate && brand === 'Casa A' && u.pathname === '/' && n >= 2 ? 'Casa B' : opts.sameTitle ? 'Casa A' : brand;
    const headers = { 'x-vercel-id': 'cdg1::fra1::abc', 'cache-control': 'private, no-store' };
    switch (u.pathname) {
      case '/':
        return new Response(`<html><head><title>${shownBrand}</title></head></html>`, { status: 200, headers });
      case '/api/health':
        return json(200, opts.healthLeak ? { status: 'ok', db: { latencyMs: 4 } } : { status: 'ok' }, headers);
      case '/robots.txt':
        return new Response(`Sitemap: https://${opts.foreignSitemap ? 'b.ejemplo.es' : u.host}/sitemap.xml`, { status: 200, headers });
      case '/sitemap.xml':
        return new Response(`<urlset><url><loc>https://${u.host}/</loc></url></urlset>`, { status: 200, headers });
    }
    return new Response('nope', { status: 404 });
  };
}

describe('probeHosts', () => {
  const origins = ['https://a.ejemplo.es', 'https://b.ejemplo.es'];

  it('pasa con dos clientes bien aislados', async () => {
    const checks = await probeHosts({ origins, region: 'fra1', unknownOrigin: 'https://z.ejemplo.es', fetch: fakeHosts() });
    expect(hasFailures(checks)).toBe(false);
    expect(byId(checks, 'host.distinct')?.status).toBe('pass');
    expect(byId(checks, 'host.region.https://a.ejemplo.es')?.status).toBe('pass');
    expect(byId(checks, 'host.desconocido')?.status).toBe('pass');
  });

  it('detecta una caché que sirve a un dominio la página del otro', async () => {
    const checks = await probeHosts({ origins, fetch: fakeHosts({ contaminate: true }) });
    expect(byId(checks, 'host.title-stable.https://a.ejemplo.es')?.status).toBe('fail');
  });

  it('falla si los dos dominios se ven iguales, salvo que sean la misma marca', async () => {
    expect(byId(await probeHosts({ origins, fetch: fakeHosts({ sameTitle: true }) }), 'host.distinct')?.status).toBe('fail');
    expect(byId(await probeHosts({ origins, sameTenant: true, fetch: fakeHosts({ sameTitle: true }) }), 'host.distinct')).toBeUndefined();
  });

  it('falla si /api/health público filtra detalle, si un robots nombra a otro cliente o si el dominio desconocido no da 404', async () => {
    const leak = await probeHosts({ origins, fetch: fakeHosts({ healthLeak: true }) });
    expect(byId(leak, 'host.health-public.https://a.ejemplo.es')?.status).toBe('fail');
    const foreign = await probeHosts({ origins, fetch: fakeHosts({ foreignSitemap: true }) });
    expect(byId(foreign, 'host.foreign.https://a.ejemplo.es/robots.txt')?.status).toBe('fail');
    const unknown = await probeHosts({ origins, unknownOrigin: 'https://a.ejemplo.es', fetch: fakeHosts() });
    expect(byId(unknown, 'host.desconocido')?.status).toBe('fail');
  });

  it('falla si las funciones corren en otra región', async () => {
    expect(byId(await probeHosts({ origins, region: 'iad1', fetch: fakeHosts() }), 'host.region.https://a.ejemplo.es')?.status).toBe('fail');
  });
});

describe('probeCron', () => {
  const secret = 'un-secreto-de-cron-de-24-caracteres';
  const fakePanel = (tenants: { status: number; body: object }) => async (input: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== `Bearer ${secret}`) return json(401, { error: 'No autorizado' });
    const job = new URL(input).searchParams.get('job');
    return job === 'tenants' ? json(tenants.status, tenants.body) : json(200, { published: 3, failed: 0 });
  };

  it('pasa cuando el disparador exige el secreto y lanza tareas', async () => {
    const checks = await probeCron({ panelUrl: 'https://panel.ejemplo.es', secret, fetch: fakePanel({ status: 200, body: { due: 2, ran: 2, ok: 2, failed: 0, deferred: 0 } }) });
    expect(hasFailures(checks)).toBe(false);
    expect(byId(checks, 'cron.snapshots')?.title).toContain('3');
  });

  it('falla con un 500 o con tareas vencidas sin lanzar, y distingue un secreto que no vale', async () => {
    expect(byId(await probeCron({ panelUrl: 'https://p.es', secret, fetch: fakePanel({ status: 500, body: { due: 1, ran: 1, ok: 0, failed: 1, deferred: 0 } }) }), 'cron.tenants')?.status).toBe('fail');
    expect(byId(await probeCron({ panelUrl: 'https://p.es', secret, fetch: fakePanel({ status: 200, body: { due: 3, ran: 0, ok: 0, failed: 0, deferred: 3 } }) }), 'cron.tenants')?.status).toBe('fail');
    const wrong = await probeCron({ panelUrl: 'https://p.es', secret: 'otro-secreto-distinto-de-24-car', fetch: fakePanel({ status: 200, body: {} }) });
    expect(byId(wrong, 'cron.tenants')?.detail).toContain('CRON_SECRET');
  });
});

describe('probeDatabase (contra un Postgres local desechable)', () => {
  const name = 'lagrailla_scratch_infra_probe';
  let url: string;
  beforeAll(async () => {
    url = await createScratchDb(name);
  });
  afterAll(async () => {
    await dropScratchDb(name);
  });

  it('comprueba el lock_timeout de arranque, que corta una espera real, y los locks por la URL «pooled»', async () => {
    const checks = await probeDatabase({ directUrl: url, pooledUrl: url, samples: 3 });
    expect(hasFailures(checks)).toBe(false);
    expect(byId(checks, 'db.lock-timeout-option')?.status).toBe('pass');
    expect(byId(checks, 'db.lock-timeout-scope')?.status).toBe('pass');
    expect(byId(checks, 'db.lock-timeout-effect')?.status).toBe('pass');
    expect(byId(checks, 'db.pooled-advisory')?.status).toBe('pass');
  }, 30_000);

  it('informa de que no se pudo conectar sin mostrar la URL', async () => {
    const bad = url.replace(/\/[^/?]+(\?|$)/, '/no_existe_esta_bd$1');
    const checks = await probeDatabase({ directUrl: bad, samples: 1 });
    expect(byId(checks, 'db.connect')?.status).toBe('fail');
    expect(formatReport(checks, [bad])).not.toContain(bad);
  }, 30_000);
});
