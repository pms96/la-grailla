import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { generateMasterKey, parseMasterKey } from '@grailla/contracts';
import { gateByModuleAndLicense, gateBySchema, isNeverBlockable, platformMiddleware } from '@/lib/tenant/middleware';
import { isLicenseExempt, ownerOfPath } from '@/lib/modules/registry';
import { CONTEXT_HEADER } from '@/lib/tenant/context';
import { verifyContext } from '@/lib/tenant/context-verify';
import { resetResolverStateForTests, resolveHost, setRegistryReaderForTests } from '@/lib/tenant/resolve';
import { FRONT_MIN_SCHEMA } from '@/lib/platform/min-schema';
import { enablePlatformEnv } from '../helpers/platform';
import { FakeRegistry, makeSigner, publishTenant } from '../helpers/registry';

/* M7: puerta por versión de esquema. Un cliente cuya BD está por detrás de lo que exige este build recibe «en mantenimiento»;
 * el resto de clientes del mismo despliegue no se enteran. */

const MIN = '20261027140000_legal_acceptance';
const OLDER = '20261008213000_contact_inbox';
const NEWER = '20271231000000_futura';

describe('gateBySchema (pura)', () => {
  it('el mínimo de este build es el que declara lib/platform/min-schema.ts', () => {
    expect(FRONT_MIN_SCHEMA).toBe(MIN);
  });

  it('un cliente al día (igual o posterior) se sirve', () => {
    expect(gateBySchema('/eventos', MIN, MIN)).toBeNull();
    expect(gateBySchema('/eventos', NEWER, MIN)).toBeNull();
  });

  it('un cliente atrasado recibe 503: JSON en /api/, texto en el resto', () => {
    expect(gateBySchema('/api/events', OLDER, MIN)).toEqual({ kind: 'api', status: 503, message: 'Cliente en mantenimiento' });
    expect(gateBySchema('/eventos', OLDER, MIN)).toEqual({ kind: 'plain', status: 503, message: 'Cliente en mantenimiento' });
    expect(gateBySchema('/admin', OLDER, MIN)?.kind).toBe('plain');
  });

  it('un esquema desconocido (null, ausente o ilegible) cuenta como atrasado: ante la duda, no se sirve', () => {
    expect(gateBySchema('/eventos', null, MIN)).not.toBeNull();
    expect(gateBySchema('/eventos', undefined, MIN)).not.toBeNull();
    expect(gateBySchema('/eventos', 'basura', MIN)).not.toBeNull();
    expect(gateBySchema('/eventos', '', MIN)).not.toBeNull();
  });

  it('/api/health se sirve siempre, también a un cliente atrasado o desconocido', () => {
    expect(gateBySchema('/api/health', OLDER, MIN)).toBeNull();
    expect(gateBySchema('/api/health', null, MIN)).toBeNull();
  });

  it('usa FRONT_MIN_SCHEMA por defecto', () => {
    expect(gateBySchema('/eventos', OLDER)).not.toBeNull();
    expect(gateBySchema('/eventos', FRONT_MIN_SCHEMA)).toBeNull();
  });
});

const UP = '01HF7YAT00AAAAAAAAAAAAAAAA';
const BEHIND = '01HF7YAT00BBBBBBBBBBBBBBBB';
const UNKNOWN = '01HF7YAT00CCCCCCCCCCCCCCCC';
const SUSPENDED_BEHIND = '01HF7YAT00DDDDDDDDDDDDDDDD';
const master = parseMasterKey(generateMasterKey());
let env: ReturnType<typeof enablePlatformEnv>;

beforeEach(async () => {
  const signer = await makeSigner();
  env = enablePlatformEnv({ SNAPSHOT_PUBKEYS: JSON.stringify({ [signer.kid]: signer.publicKey }) });
  const reg = new FakeRegistry();
  resetResolverStateForTests();
  setRegistryReaderForTests(reg);
  const base = { master, modules: ['tienda', 'entradas'] };
  await publishTenant(reg, signer, { ...base, tenantId: UP, hosts: ['al-dia.cliente.test'], schemaVersion: FRONT_MIN_SCHEMA });
  await publishTenant(reg, signer, { ...base, tenantId: BEHIND, hosts: ['atrasado.cliente.test'], schemaVersion: OLDER });
  await publishTenant(reg, signer, { ...base, tenantId: UNKNOWN, hosts: ['sin-version.cliente.test'], schemaVersion: null });
  await publishTenant(reg, signer, { ...base, tenantId: SUSPENDED_BEHIND, hosts: ['suspendido.cliente.test'], schemaVersion: OLDER, status: 'SUSPENDED' });
});
afterEach(() => {
  env.restore();
  setRegistryReaderForTests(null);
  resetResolverStateForTests();
});

const req = (host: string, path: string, method = 'GET') => new NextRequest(`http://${host}${path}`, { method, headers: { host } });
const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('platformMiddleware: puerta de esquema con dos clientes', () => {
  it('el cliente al día se sirve; el atrasado recibe 503 «Cliente en mantenimiento» con Retry-After y sin caché', async () => {
    expect(passed(await platformMiddleware(req('al-dia.cliente.test', '/eventos')))).toBe(true);

    const page = await platformMiddleware(req('atrasado.cliente.test', '/eventos'));
    expect(page.status).toBe(503);
    expect(await page.text()).toBe('Cliente en mantenimiento');
    expect(page.headers.get('retry-after')).toBe('30');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-type')).toMatch(/text\/plain/);
    expect(passed(page)).toBe(false);

    const api = await platformMiddleware(req('atrasado.cliente.test', '/api/events'));
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: 'Cliente en mantenimiento' });
    expect(api.headers.get('retry-after')).toBe('30');
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(api.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('el atrasado corta también páginas de admin, webhooks y crons que dependen de la BD (el 503 los reintenta); el al día no', async () => {
    for (const path of ['/', '/admin', '/api/webhooks/stripe', '/api/cron/reconcile-payments']) {
      const res = await platformMiddleware(req('atrasado.cliente.test', path, path.startsWith('/api/webhooks') ? 'POST' : 'GET'));
      expect(res.status, path).toBe(503);
    }
    expect(passed(await platformMiddleware(req('al-dia.cliente.test', '/api/cron/reconcile-payments')))).toBe(true);
  });

  it('un cliente sin versión de esquema en el registro (null) también se corta', async () => {
    expect((await platformMiddleware(req('sin-version.cliente.test', '/eventos'))).status).toBe(503);
  });

  it('/api/health responde aunque el cliente esté atrasado, sin versión o suspendido', async () => {
    for (const host of ['atrasado.cliente.test', 'sin-version.cliente.test', 'suspendido.cliente.test', 'al-dia.cliente.test']) {
      expect(passed(await platformMiddleware(req(host, '/api/health'))), host).toBe(true);
    }
  });

  it('un cliente suspendido atrasado sigue recibiendo el aviso de suspensión (va antes que la puerta de esquema)', async () => {
    expect(await (await platformMiddleware(req('suspendido.cliente.test', '/eventos'))).text()).toBe('Servicio suspendido');
  });

  it('el contexto que llega a los handlers lleva el schemaVersion del cliente', async () => {
    const res = await platformMiddleware(req('al-dia.cliente.test', '/eventos'));
    const ctx = verifyContext(res.headers.get(`x-middleware-request-${CONTEXT_HEADER}`)!, parseMasterKey(env.PLATFORM_CONTEXT_KEY), Date.now());
    expect(ctx?.schemaVersion).toBe(FRONT_MIN_SCHEMA);
  });

  it('el resolutor rellena schemaVersion desde el registro (también null)', async () => {
    const a = await resolveHost('al-dia.cliente.test');
    const c = await resolveHost('sin-version.cliente.test');
    expect(a.status === 'ok' && a.ctx.schemaVersion).toBe(FRONT_MIN_SCHEMA);
    expect(c.status === 'ok' && c.ctx.schemaVersion).toBeNull();
  });
});

describe('/api/health: registro y exenciones', () => {
  it('es del núcleo y no se corta por licencia ni por módulo ni por suspensión', () => {
    expect(ownerOfPath('/api/health')).toBe('nucleo');
    expect(isLicenseExempt('/api/health', 'GET')).toBe(true);
    expect(isNeverBlockable('/api/health')).toBe(true);
    expect(gateByModuleAndLicense('/api/health', 'GET', [], 'BLOCKED')).toBeNull();
    expect(gateByModuleAndLicense('/api/health', 'GET', [], 'PANEL_BLOCKED')).toBeNull();
  });

  it('las rutas parecidas no heredan la exención', () => {
    expect(isNeverBlockable('/api/health-check')).toBe(false);
    expect(isLicenseExempt('/api/healthz', 'GET')).toBe(false);
  });
});
