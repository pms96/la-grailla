import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

/* P0-07: captura explícita en los puntos de dinero, INERTE sin SENTRY_DSN. El módulo del SDK se sustituye: lo que se mira es si se carga y con qué contexto. */

const sdk = vi.hoisted(() => ({ loaded: 0, captureOps: vi.fn(), reportRequestError: vi.fn(), initSentry: vi.fn(() => true) }));
vi.mock('@/lib/observability/sentry-server', () => {
  sdk.loaded += 1; // la fábrica solo se ejecuta cuando alguien importa el módulo
  return { captureOps: sdk.captureOps, reportRequestError: sdk.reportRequestError, initSentry: sdk.initSentry };
});

import { captureOpsError, minimalContext, safeTenantId, sentryEnabled } from '@/lib/observability/capture';
import { handleApiError } from '@/lib/api-error';
import { runWithTenant } from '@/lib/tenant/context';

const tick = () => new Promise((r) => setTimeout(r, 5));
const ORDER = 'cm9abcdef0123456789zzzzz';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('SENTRY_DSN', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('sin SENTRY_DSN: inerte', () => {
  it('no carga el SDK ni captura nada', async () => {
    const before = sdk.loaded;
    captureOpsError(new Error('x'), { route: 'POST /api/orders', orderId: ORDER });
    await tick();
    expect(sdk.loaded).toBe(before);
    expect(sdk.captureOps).not.toHaveBeenCalled();
    expect(sentryEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(sentryEnabled({ SENTRY_DSN: ' ' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('handleApiError responde un 500 genérico con texto para la persona y el código técnico aparte, y no carga el SDK', async () => {
    const before = sdk.loaded;
    const res = handleApiError(new Error('BD caída'), 'POST /api/orders');
    expect(res.status).toBe(500);
    // H-084: antes `error` era el código crudo («internal_server_error») y ~40 pantallas lo enseñaban tal cual al comprador.
    expect(await res.json()).toEqual({ error: expect.stringMatching(/error inesperado/i), code: 'internal_server_error' });
    await tick();
    expect(sdk.loaded).toBe(before);
  });
});

describe('con SENTRY_DSN', () => {
  beforeEach(() => void vi.stubEnv('SENTRY_DSN', 'https://k@o0.ingest.de.sentry.io/1'));

  it('captura con el contexto mínimo y el pedido TRUNCADO a 8 caracteres', async () => {
    captureOpsError(new Error('boom'), { route: 'POST /api/webhooks/stripe', orderId: ORDER, provider: 'stripe', kind: 'entradas', reason: 'failed_pass' });
    await tick();
    expect(sdk.captureOps).toHaveBeenCalledTimes(1);
    const [error, tags, tenant] = sdk.captureOps.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(tags).toEqual({ route: 'POST /api/webhooks/stripe', provider: 'stripe', kind: 'entradas', reason: 'failed_pass', order: 'cm9abcde' });
    expect(JSON.stringify(tags)).not.toContain(ORDER);
    expect(tenant).toBeNull();
  });

  it('lee el id del cliente DENTRO de la petición y lo pasa como dato (más tarde el contexto ya no existe)', async () => {
    runWithTenant({ tenantId: '01JTENANTXXXXXXXXXXXXXXXXX' } as never, () => captureOpsError(new Error('x'), { route: 'GET /x' }));
    await tick();
    expect(sdk.captureOps.mock.calls[0][2]).toBe('01JTENANTXXXXXXXXXXXXXXXXX');
  });

  it('el contexto mínimo descarta campos desconocidos (nunca datos del comprador) y recorta lo largo', () => {
    const dirty = { route: 'x'.repeat(500), buyerEmail: 'ana@correo.es', buyerName: 'Ana', orderId: ORDER, totalAmount: 25 } as never;
    const out = minimalContext(dirty);
    expect(Object.keys(out).sort()).toEqual(['order', 'route']);
    expect(out.route).toHaveLength(120);
  });

  it('no lanza ni espera aunque el SDK falle al cargarse o al capturar', async () => {
    sdk.captureOps.mockImplementationOnce(() => {
      throw new Error('el SDK explotó');
    });
    expect(() => captureOpsError(new Error('x'), {})).not.toThrow();
    await tick();
  });

  it('safeTenantId no lanza fuera de una petición', () => {
    expect(safeTenantId()).toBeNull();
  });

  describe('handleApiError', () => {
    it('un 500 inesperado se captura con la ruta; el cuerpo de la respuesta no cambia', async () => {
      const res = handleApiError(new Error('inesperado'), 'POST /api/orders');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: expect.stringMatching(/error inesperado/i), code: 'internal_server_error' });
      await tick();
      expect(sdk.captureOps).toHaveBeenCalledTimes(1);
      expect(sdk.captureOps.mock.calls[0][1]).toEqual({ route: 'POST /api/orders' });
    });

    it('añade proveedor y tipo cuando el llamante los conoce (webhooks)', async () => {
      handleApiError(new Error('x'), 'POST /api/webhooks/stripe', { provider: 'stripe', kind: 'tienda' });
      await tick();
      expect(sdk.captureOps.mock.calls[0][1]).toEqual({ route: 'POST /api/webhooks/stripe', provider: 'stripe', kind: 'tienda' });
    });

    it('NO captura los 4xx de validación (ZodError → 400) ni el 409 por claves foráneas', async () => {
      const zod = new ZodError([{ code: 'custom', path: ['email'], message: 'inválido' }]);
      expect(handleApiError(zod, 'POST /api/orders').status).toBe(400);
      const fk = new Prisma.PrismaClientKnownRequestError('FK', { code: 'P2003', clientVersion: 'x' });
      expect(handleApiError(fk, 'DELETE /api/admin/events/x').status).toBe(409);
      await tick();
      expect(sdk.captureOps).not.toHaveBeenCalled();
    });

    it('un error de Prisma que SÍ es un 500 se captura (el filtro quita los valores de la consulta al enviarse)', async () => {
      const err = new Prisma.PrismaClientKnownRequestError('Invalid `prisma.order.create()` invocation: ... buyerEmail ana@correo.es', { code: 'P2022', clientVersion: 'x' });
      expect(handleApiError(err, 'POST /api/orders').status).toBe(500);
      await tick();
      expect(sdk.captureOps).toHaveBeenCalledTimes(1);
    });
  });
});
