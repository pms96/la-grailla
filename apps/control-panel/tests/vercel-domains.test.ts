import { describe, expect, it } from 'vitest';
import { ServiceError } from '@/lib/services/errors';
import { describeDomainSetup, dnsRecordsFor, ensureVercelDomain, vercelConfig, type VercelConfig } from '@/lib/services/vercel-domains';

const CFG: VercelConfig = { token: 'tok-de-prueba-ZZZ-no-real', projectId: 'prj_demo', teamId: 'team_demo' };

type Call = { method: string; url: string; body: unknown; auth: string | null };
/** API de Vercel de mentira: responde según «método + ruta» y apunta lo que recibe. */
function fakeVercel(routes: Record<string, { status: number; json?: unknown } | Error>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url: input, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get('authorization') });
    const hit = routes[`${method} ${url.pathname}`];
    if (!hit) return new Response('{}', { status: 404 });
    if (hit instanceof Error) throw hit;
    return new Response(JSON.stringify(hit.json ?? {}), { status: hit.status });
  };
  return { fetchImpl, calls };
}

const PROJECT = '/v9/projects/prj_demo/domains';
const ADD = '/v10/projects/prj_demo/domains';

describe('configuración', () => {
  it('sin token o sin proyecto la función no existe', () => {
    expect(vercelConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(vercelConfig({ VERCEL_API_TOKEN: 't' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(vercelConfig({ VERCEL_PLATFORM_PROJECT_ID: 'p' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(vercelConfig({ VERCEL_API_TOKEN: ' t ', VERCEL_PLATFORM_PROJECT_ID: 'p', VERCEL_TEAM_ID: ' team_x ' } as unknown as NodeJS.ProcessEnv)).toEqual({ token: 't', projectId: 'p', teamId: 'team_x' });
  });
});

describe('añadir un dominio al proyecto', () => {
  it('si no estaba, lo añade y dice qué CNAME crear; el token solo va en la cabecera y el equipo en la consulta', async () => {
    const { fetchImpl, calls } = fakeVercel({
      [`GET ${PROJECT}/demo.cliente.es`]: { status: 404 },
      [`POST ${ADD}`]: { status: 200, json: { name: 'demo.cliente.es', apexName: 'cliente.es', verified: true } },
      'GET /v6/domains/demo.cliente.es/config': { status: 200, json: { misconfigured: true, recommendedCNAME: [{ rank: 1, value: 'abc123.vercel-dns-017.com.' }] } },
    });
    const s = await ensureVercelDomain('demo.cliente.es', CFG, fetchImpl);
    expect(s).toEqual({
      host: 'demo.cliente.es',
      inProject: false,
      created: true,
      verified: true,
      misconfigured: true,
      records: [{ type: 'CNAME', name: 'demo.cliente.es', value: 'abc123.vercel-dns-017.com' }],
    });
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'demo.cliente.es' });
    for (const c of calls) {
      expect(c.auth).toBe(`Bearer ${CFG.token}`);
      expect(c.url).not.toContain(CFG.token);
      expect(c.url).toContain('teamId=team_demo');
    }
  });

  it('si ya estaba en el proyecto no lo vuelve a añadir (repetible)', async () => {
    const { fetchImpl, calls } = fakeVercel({
      [`GET ${PROJECT}/demo.cliente.es`]: { status: 200, json: { name: 'demo.cliente.es', apexName: 'cliente.es', verified: true } },
      'GET /v6/domains/demo.cliente.es/config': { status: 200, json: { misconfigured: false } },
    });
    const s = await ensureVercelDomain('demo.cliente.es', CFG, fetchImpl);
    expect(s).toMatchObject({ inProject: true, created: false, misconfigured: false, records: [] });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(describeDomainSetup(s)).toEqual(['✓ demo.cliente.es ya estaba en el proyecto de Vercel', '✓ El DNS ya apunta a Vercel']);
  });

  it('un dominio raíz pide un registro A, y uno de otra cuenta pide además el TXT de verificación', async () => {
    const { fetchImpl } = fakeVercel({
      [`GET ${PROJECT}/cliente.es`]: { status: 404 },
      [`POST ${ADD}`]: { status: 200, json: { name: 'cliente.es', apexName: 'cliente.es', verified: false, verification: [{ type: 'TXT', domain: '_vercel.cliente.es', value: 'vc-domain-verify=cliente.es,abc', reason: 'pending_domain_verification' }] } },
      'GET /v6/domains/cliente.es/config': { status: 200, json: { misconfigured: true } },
    });
    const s = await ensureVercelDomain('cliente.es', CFG, fetchImpl);
    expect(s.records).toEqual([
      { type: 'TXT', name: '_vercel.cliente.es', value: 'vc-domain-verify=cliente.es,abc' },
      { type: 'A', name: 'cliente.es', value: '76.76.21.21' },
    ]);
    const text = describeDomainSetup(s).join('\n');
    expect(text).toMatch(/TXT _vercel\.cliente\.es/);
    expect(text).toMatch(/A cliente\.es → 76\.76\.21\.21/);
    expect(text).toMatch(/todavía no da el dominio por verificado/);
  });

  it('sin valores recomendados usa los clásicos de Vercel', () => {
    expect(dnsRecordsFor('www.cliente.es', 'cliente.es', undefined, null)).toEqual([{ type: 'CNAME', name: 'www.cliente.es', value: 'cname.vercel-dns.com' }]);
    expect(dnsRecordsFor('cliente.es', undefined, undefined, { misconfigured: true, recommendedIPv4: [{ rank: 1, value: ['203.0.113.7'] }] })).toEqual([{ type: 'A', name: 'cliente.es', value: '203.0.113.7' }]);
  });

  it('si falla la comprobación del DNS, no pierde lo hecho y lo dice', async () => {
    const { fetchImpl } = fakeVercel({
      [`GET ${PROJECT}/demo.cliente.es`]: { status: 404 },
      [`POST ${ADD}`]: { status: 200, json: { name: 'demo.cliente.es', verified: true } },
      'GET /v6/domains/demo.cliente.es/config': new Error('boom'),
    });
    const s = await ensureVercelDomain('demo.cliente.es', CFG, fetchImpl);
    expect(s).toMatchObject({ created: true, misconfigured: null });
    expect(describeDomainSetup(s).join('\n')).toMatch(/No se pudo comprobar el DNS/);
  });
});

describe('errores', () => {
  const run = (routes: Parameters<typeof fakeVercel>[0], host = 'demo.cliente.es') => ensureVercelDomain(host, CFG, fakeVercel(routes).fetchImpl);

  it('un dominio que está en otro proyecto se explica', async () => {
    await expect(run({ [`GET ${PROJECT}/demo.cliente.es`]: { status: 404 }, [`POST ${ADD}`]: { status: 409, json: { error: { code: 'domain_already_in_use', message: 'x' } } } })).rejects.toMatchObject({ code: 'domain_in_other_project' });
  });

  it('un token rechazado se explica sin mostrar el token', async () => {
    const err = await run({ [`GET ${PROJECT}/demo.cliente.es`]: { status: 403, json: { error: { code: 'forbidden', message: `Not authorized ${CFG.token}` } } } }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('vercel_forbidden');
    expect(err.message).not.toContain(CFG.token);
  });

  it('un error de red no filtra nada y un 500 lleva el código de Vercel', async () => {
    await expect(run({ [`GET ${PROJECT}/demo.cliente.es`]: new Error(`fetch failed ${CFG.token}`) })).rejects.toMatchObject({ code: 'vercel_unreachable' });
    const err = await run({ [`GET ${PROJECT}/demo.cliente.es`]: { status: 500, json: { error: { code: 'internal', message: 'caído' } } } }).catch((e) => e);
    expect(err.message).toMatch(/500 \(internal\): caído/);
    expect(err.message).not.toContain(CFG.token);
  });

  it('un dominio con forma rara ni se envía', async () => {
    const { fetchImpl, calls } = fakeVercel({});
    await expect(ensureVercelDomain('no es un dominio/../x', CFG, fetchImpl)).rejects.toMatchObject({ code: 'invalid_host' });
    await expect(ensureVercelDomain('localhost', CFG, fetchImpl)).rejects.toMatchObject({ code: 'invalid_host' });
    expect(calls).toHaveLength(0);
  });
});
