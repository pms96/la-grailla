import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* P0-07: instrumentation.ts de Next. Inerte sin SENTRY_DSN y solo en el runtime Node. */

const sdk = vi.hoisted(() => ({ loaded: 0, initSentry: vi.fn(() => true), reportRequestError: vi.fn() }));
vi.mock('@/lib/observability/sentry-server', () => {
  sdk.loaded += 1;
  return { initSentry: sdk.initSentry, reportRequestError: sdk.reportRequestError };
});

const req = { path: '/x', method: 'GET', headers: {} };
const errCtx = { routerKind: 'App Router', routePath: '/x', routeType: 'render' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

describe('instrumentation.ts', () => {
  it('sin SENTRY_DSN: register no carga ni inicializa nada, y onRequestError tampoco', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('SENTRY_DSN', '');
    const before = sdk.loaded;
    const { register, onRequestError } = await import('@/instrumentation');
    await register();
    await onRequestError(new Error('x'), req, errCtx);
    expect(sdk.loaded).toBe(before);
    expect(sdk.initSentry).not.toHaveBeenCalled();
    expect(sdk.reportRequestError).not.toHaveBeenCalled();
  });

  it('con DSN y runtime Node: register inicializa el SDK y onRequestError lo informa', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('SENTRY_DSN', 'https://k@o0.ingest.de.sentry.io/1');
    const { register, onRequestError } = await import('@/instrumentation');
    await register();
    expect(sdk.initSentry).toHaveBeenCalledTimes(1);
    const error = new Error('x');
    await onRequestError(error, req, errCtx);
    expect(sdk.reportRequestError).toHaveBeenCalledWith(error, req, errCtx);
  });

  it.each(['edge', undefined])('en el runtime %s (middleware) no se carga el SDK aunque haya DSN', async (runtime) => {
    if (runtime) vi.stubEnv('NEXT_RUNTIME', runtime);
    else vi.stubEnv('NEXT_RUNTIME', '');
    vi.stubEnv('SENTRY_DSN', 'https://k@o0.ingest.de.sentry.io/1');
    const before = sdk.loaded;
    const { register, onRequestError } = await import('@/instrumentation');
    await register();
    await onRequestError(new Error('x'), req, errCtx);
    expect(sdk.loaded).toBe(before);
  });

  it('un fallo del SDK en onRequestError no se propaga a Next', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('SENTRY_DSN', 'https://k@o0.ingest.de.sentry.io/1');
    sdk.reportRequestError.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { onRequestError } = await import('@/instrumentation');
    await expect(onRequestError(new Error('x'), req, errCtx)).resolves.toBeUndefined();
  });

  describe('un fallo del SDK nunca impide arrancar (M5)', () => {
    const boot = async () => {
      vi.stubEnv('NEXT_RUNTIME', 'nodejs');
      vi.stubEnv('SENTRY_DSN', 'https://k@o0.ingest.de.sentry.io/1');
      return import('@/instrumentation');
    };

    it('register: si el import del SDK lanza, no rechaza y lo anota UNA sola vez', async () => {
      vi.doMock('@/lib/observability/sentry-server', () => {
        throw new Error('no se pudo cargar @sentry/nextjs');
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { register, onRequestError } = await boot();
      await expect(register()).resolves.toBeUndefined();
      await expect(register()).resolves.toBeUndefined();
      await expect(onRequestError(new Error('x'), req, errCtx)).resolves.toBeUndefined();
      expect(log.mock.calls.filter((c) => String(c[0]).includes('[sentry]'))).toHaveLength(1);
      expect(String(log.mock.calls[0][0])).not.toContain('@sentry/nextjs'); // sin el mensaje del error: solo su nombre
      log.mockRestore();
      vi.doUnmock('@/lib/observability/sentry-server');
    });

    it('register: si initSentry lanza, tampoco rechaza', async () => {
      sdk.initSentry.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { register } = await boot();
      await expect(register()).resolves.toBeUndefined();
      log.mockRestore();
    });
  });
});
