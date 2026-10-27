import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { CAPTURE_MAX_PER_WINDOW, CAPTURE_WINDOW_MS, allowCapture, buildSentryOptions, captureOps, initSentry, reportRequestError, resetCaptureLimitForTests, tenantFromRequestHeaders } from '@/lib/observability/sentry-server';
import { runWithTenant } from '@/lib/tenant/context';
import { signContext } from '@/lib/tenant/context-sign';
import { generateMasterKey, parseMasterKey } from '@grailla/contracts';

/* P0-07: el SDK real (`@sentry/nextjs`) con un transporte simulado: nunca se envía nada a un Sentry. Lo que se mira es lo que SALDRÍA. */

const DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
const TENANT = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const ctx = (tenantId = TENANT) => ({ tenantId, product: 'grailla', host: 'peña-ejemplo.es', primaryDomain: 'peña-ejemplo.es', epoch: 1, status: 'ACTIVE' as const, modules: [], db: { pooledEnc: 'x', directEnc: 'y' } });

type Envelope = [Record<string, unknown>, [Record<string, unknown>, Record<string, any>][]];
const sent: Envelope[] = [];
const transport = () => ({
  send: async (envelope: Envelope) => {
    sent.push(envelope);
    return { statusCode: 200 };
  },
  flush: async () => true,
});
const events = () => sent.flatMap(([, items]) => items.filter(([h]) => h.type === 'event').map(([, payload]) => payload));

beforeEach(() => {
  sent.length = 0;
  resetCaptureLimitForTests();
});
afterEach(async () => {
  await Sentry.close(1000);
  vi.restoreAllMocks();
});

describe('buildSentryOptions', () => {
  it('sin DSN no hay opciones (no se inicializa nada)', () => {
    expect(buildSentryOptions({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(buildSentryOptions({ SENTRY_DSN: '  ' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(initSentry({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
  });

  it('configuración mínima: solo errores, sin PII, entorno y release de Vercel', () => {
    const o = buildSentryOptions({ SENTRY_DSN: DSN, VERCEL_ENV: 'production', NODE_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'abc123' } as unknown as NodeJS.ProcessEnv)!;
    expect(o).toMatchObject({ dsn: DSN, environment: 'production', release: 'abc123', tracesSampleRate: 0, maxBreadcrumbs: 5, enableOpenTelemetrySetup: false, enableRuntimeChannelInjection: false, defaultIntegrations: false });
    // La versión 11 recoge por defecto usuario, cookies, cabeceras, cuerpos, query y variables locales: cada categoría debe quedar apagada.
    expect(o.dataCollection).toMatchObject({ userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 });
    expect(o.dataCollection?.graphQL).toEqual({ document: false, variables: false });
    expect(o.dataCollection?.genAI).toEqual({ inputs: false, outputs: false });
    expect(o.beforeSend).toBeTypeOf('function');
    expect(o.beforeBreadcrumb).toBeTypeOf('function');
  });

  it('el entorno cae a NODE_ENV y el release queda sin definir si no hay SHA', () => {
    const o = buildSentryOptions({ SENTRY_DSN: DSN, NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv)!;
    expect(o.environment).toBe('development');
    expect(o.release).toBeUndefined();
  });

  it('solo trae integraciones sin efectos sobre el servidor (nada de consola, HTTP ni manejadores globales)', () => {
    const o = buildSentryOptions({ SENTRY_DSN: DSN } as unknown as NodeJS.ProcessEnv)!;
    const names = (o.integrations as { name: string }[]).map((i) => i.name);
    expect(names.sort()).toEqual(['Dedupe', 'EventFilters', 'LinkedErrors']);
  });
});

describe('tope de capturas por instancia', () => {
  it('permite hasta el máximo por minuto y vuelve a permitir al pasar la ventana', () => {
    for (let i = 0; i < CAPTURE_MAX_PER_WINDOW; i++) expect(allowCapture(1_000 + i)).toBe(true);
    expect(allowCapture(2_000)).toBe(false);
    expect(allowCapture(1_000 + CAPTURE_WINDOW_MS + CAPTURE_MAX_PER_WINDOW)).toBe(true);
  });

  it('una avalancha de errores (BD caída) no manda un evento por petición', async () => {
    initSentry({ SENTRY_DSN: DSN } as unknown as NodeJS.ProcessEnv, { transport: transport as never });
    for (let i = 0; i < CAPTURE_MAX_PER_WINDOW * 3; i++) captureOps(new Error(`caída ${i}`), { route: 'GET /x' }, null);
    await Sentry.flush(2000);
    expect(events().length).toBe(CAPTURE_MAX_PER_WINDOW);
  });
});

describe('inicialización', () => {
  it('con DSN inicializa el SDK; un fallo del SDK no lanza', () => {
    expect(initSentry({ SENTRY_DSN: DSN } as unknown as NodeJS.ProcessEnv, { transport: transport as never })).toBe(true);
    expect(Sentry.getClient()).toBeDefined();
  });

  it('un fallo al inicializar se queda en el log y no impide arrancar', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(initSentry({ SENTRY_DSN: DSN } as unknown as NodeJS.ProcessEnv, { transport: (() => { throw new Error('boom'); }) as never })).toBe(false);
    expect(err.mock.calls.flat().join(' ')).toContain('[sentry]');
  });
});

describe('captura con el SDK real y transporte simulado', () => {
  beforeEach(() => void initSentry({ SENTRY_DSN: DSN, VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'sha1' } as unknown as NodeJS.ProcessEnv, { transport: transport as never }));

  it('captureOps envía un evento con el contexto mínimo y el tenant, sin PII', async () => {
    runWithTenant(ctx() as never, () => {
      const error = new Error('Fallo con ana@correo.es y 612345678 usando Bearer abc.def.ghi');
      captureOps(error, { route: 'POST /api/webhooks/stripe', provider: 'stripe', kind: 'entradas', order: '3f2504e0' }, TENANT);
    });
    await Sentry.flush(2000);
    const [e] = events();
    expect(e).toBeDefined();
    expect(e.tags).toMatchObject({ tenant: TENANT, route: 'POST /api/webhooks/stripe', provider: 'stripe', kind: 'entradas', order: '3f2504e0', deployment: 'single' });
    expect(e.environment).toBe('production');
    expect(e.release).toBe('sha1');
    const json = JSON.stringify(e);
    for (const leak of ['ana@correo.es', '612345678', 'abc.def.ghi', 'peña-ejemplo', 'ip-']) expect(json).not.toContain(leak);
    for (const k of ['request', 'user', 'server_name', 'modules', 'sdkProcessingMetadata']) expect(e).not.toHaveProperty(k);
  });

  it('la etiqueta `tenant` sale del contexto del cliente aunque el llamante no la pase, y nunca es el Host', async () => {
    runWithTenant(ctx('01JOTROCLIENTEXXXXXXXXXXXX') as never, () => captureOps(new Error('x'), { route: 'GET /api/x' }, null));
    await Sentry.flush(2000);
    expect(events()[0].tags.tenant).toBe('01JOTROCLIENTEXXXXXXXXXXXX');
    expect(JSON.stringify(events()[0])).not.toContain('peña-ejemplo');
  });

  it('sin contexto de cliente (jobs, instalación única) el evento sale sin `tenant` y no falla', async () => {
    captureOps(new Error('sin contexto'), { route: 'GET /api/cron/x' }, null);
    await Sentry.flush(2000);
    expect(events()[0].tags).not.toHaveProperty('tenant');
  });

  it('reportRequestError (onRequestError de Next): ruta como patrón, sin petición, cabeceras ni cookies', async () => {
    reportRequestError(
      new Error('render falló para ana@correo.es'),
      { path: '/confirmacion/ABCDEF?t=SECRETO123', method: 'GET', headers: { cookie: 'sesion=SESION123', authorization: 'Bearer ZZZ', host: 'peña-ejemplo.es' } },
      { routerKind: 'App Router', routePath: '/confirmacion/[orderId]', routeType: 'render' }
    );
    await Sentry.flush(2000);
    const [e] = events();
    expect(e).toBeDefined();
    const json = JSON.stringify(e);
    for (const leak of ['ana@correo.es', 'SECRETO123', 'SESION123', 'ZZZ', 'peña-ejemplo', 'ABCDEF']) expect(json, leak).not.toContain(leak);
    expect(e.contexts.nextjs).toMatchObject({ router_path: '/confirmacion/[orderId]' });
    expect(e).not.toHaveProperty('request');
    expect(e.transaction).toBe('GET /confirmacion/[orderId]');
  });

  it('reportRequestError toma el tenant de la cabecera firmada si no hay contexto (se verifica; una cabecera falsa o de otra clave no vale)', async () => {
    const master = generateMasterKey();
    vi.stubEnv('PLATFORM_CONTEXT_KEY', master);
    const signed = await signContext(ctx('01JFIRMADOXXXXXXXXXXXXXXXX') as never, parseMasterKey(master));
    expect(tenantFromRequestHeaders({ 'x-grailla-ctx': signed })).toBe('01JFIRMADOXXXXXXXXXXXXXXXX');
    expect(tenantFromRequestHeaders({ 'x-grailla-ctx': [signed] })).toBe('01JFIRMADOXXXXXXXXXXXXXXXX');
    const forged = await signContext(ctx('01JFALSOXXXXXXXXXXXXXXXXXX') as never, parseMasterKey(generateMasterKey()));
    expect(tenantFromRequestHeaders({ 'x-grailla-ctx': forged })).toBeNull();
    expect(tenantFromRequestHeaders({ 'x-grailla-ctx': 'basura.firma' })).toBeNull();
    expect(tenantFromRequestHeaders(undefined)).toBeNull();
    expect(tenantFromRequestHeaders({})).toBeNull();

    reportRequestError(new Error('render'), { path: '/x', method: 'GET', headers: { 'x-grailla-ctx': signed } }, { routerKind: 'App Router', routePath: '/x', routeType: 'render' });
    await Sentry.flush(2000);
    expect(events()[0].tags.tenant).toBe('01JFIRMADOXXXXXXXXXXXXXXXX');
    expect(JSON.stringify(events()[0])).not.toContain('x-grailla-ctx');
    vi.unstubAllEnvs();
  });

  it('un error en el filtro descarta el evento en vez de enviarlo sin depurar', async () => {
    const { beforeSend } = await import('@/lib/observability/sentry-server');
    const hostile = { get tags(): never { throw new Error('boom'); } };
    expect(beforeSend(hostile as never)).toBeNull();
  });

  it('sin cliente inicializado, capturar no hace nada ni lanza', async () => {
    await Sentry.close(1000);
    expect(() => captureOps(new Error('x'), {}, null)).not.toThrow();
    expect(() => reportRequestError(new Error('x'), { path: '/', method: 'GET', headers: {} }, { routerKind: 'a', routePath: '/', routeType: 'render' })).not.toThrow();
    await Sentry.flush(100);
    expect(events()).toHaveLength(0);
  });

  it('el envío no espera: captureOps vuelve de inmediato aunque el transporte tarde', async () => {
    await Sentry.close(1000);
    let release!: () => void;
    const slow = () => ({ send: () => new Promise((r) => (release = () => r({ statusCode: 200 }))), flush: async () => true });
    initSentry({ SENTRY_DSN: DSN } as unknown as NodeJS.ProcessEnv, { transport: slow as never });
    const t0 = Date.now();
    captureOps(new Error('lento'), { route: 'x' }, null);
    expect(Date.now() - t0).toBeLessThan(100);
    release?.();
  });
});
