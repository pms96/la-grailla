import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey } from '@grailla/contracts';
import { probeTenantHealth } from '@/lib/services/health';

/* El front devuelve en su salud la marca de la BD (platform_tenant_id). Si no es la del cliente que lo sirve, el front de este cliente está
 * leyendo la BD de otro: el panel lo marca como problema. */

const TENANT = '01HF7YAT00AAAAAAAAAAAAAAAA';
const OTHER = '01HF7YAT00BBBBBBBBBBBBBBBB';

const detail = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  version: 'abc1234',
  platform: true,
  tenantId: TENANT,
  serving: true,
  db: { ok: true, latencyMs: 4 },
  schema: { applied: '20261009090000_reconcile_queue', expected: '20261009090000_reconcile_queue', minRequired: '20261009090000_reconcile_queue', upToDate: true },
  onboarding: { complete: true, missing: [] },
  ...over,
});
const fetchWith = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllEnvs());

async function probe(body: unknown, status = 200) {
  vi.stubEnv('PLATFORM_CRON_MASTER', generateMasterKey());
  return probeTenantHealth({ tenantId: TENANT, host: 'a.cliente.test' }, { fetchImpl: fetchWith(body, status) });
}

describe('marca de la BD en la salud', () => {
  it('sin marca (cliente anterior a la plataforma) o con la del propio cliente: sin problemas', async () => {
    expect((await probe(detail())).problems).toEqual([]);
    expect((await probe(detail({ tenantMarker: null }))).problems).toEqual([]);
    expect((await probe(detail({ tenantMarker: TENANT }))).problems).toEqual([]);
  });

  it('con la marca de OTRO cliente: problema grave y visible', async () => {
    const res = await probe(detail({ tenantMarker: OTHER, status: 'error' }), 503);
    expect(res.reachable).toBe(true);
    expect(res.problems.join('\n')).toContain('LA BD ES DE OTRO CLIENTE');
    expect(res.problems.join('\n')).toContain(OTHER);
  });
});
