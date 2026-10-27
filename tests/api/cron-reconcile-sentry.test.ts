import { beforeEach, describe, expect, it, vi } from 'vitest';

/* P0-07: la pasada del reconcile que no reconcilia NADA (502) se avisa a Sentry; una pasada sana o con errores parciales, no. Sin BD: prisma y la decisión simuladas. */

const m = vi.hoisted(() => ({
  settle: vi.fn(),
  capture: vi.fn(),
  order: { id: 'cm9abcdef0123456789zzzzz', createdAt: new Date(Date.now() - 3_600_000), paymentProvider: 'stripe', paymentId: 'cs_test_a1B2c3D4e5F6g7H8i9J0' },
}));
vi.mock('@/lib/prisma', () => {
  const orders = { findMany: vi.fn(async (_a: { where?: { status?: string } }) => [m.order]), updateMany: vi.fn(async () => ({ count: 1 })), aggregate: vi.fn(async () => ({ _min: { createdAt: null } })) };
  const none = { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })), aggregate: vi.fn(async () => ({ _min: { createdAt: null } })) };
  return { prisma: { order: orders, shopOrder: none } };
});
vi.mock('@/lib/cron-auth', () => ({ authorizeCron: async () => 'ok' }));
vi.mock('@/lib/reconciliation/settle', () => ({ settleUnpaidOrder: m.settle }));
vi.mock('@/lib/observability/capture', () => ({ captureOpsError: m.capture }));

import { GET } from '@/app/api/cron/reconcile-payments/route';

const call = () => GET(new Request('http://localhost/api/cron/reconcile-payments'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('reconcile-payments → Sentry', () => {
  it('una pasada donde todo falla (502) se avisa, sin datos de pedidos', async () => {
    m.settle.mockResolvedValue({ outcome: 'unknown', reason: 'gateway_error' });
    const res = await call();
    expect(res.status).toBe(502);
    expect(m.capture).toHaveBeenCalledTimes(1);
    const [error, ctx] = m.capture.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(ctx).toEqual({ route: 'GET /api/cron/reconcile-payments', reason: 'failed_pass' });
  });

  it('una pasada sana no avisa', async () => {
    m.settle.mockResolvedValue({ outcome: 'completed' });
    expect((await call()).status).toBe(200);
    expect(m.capture).not.toHaveBeenCalled();
  });

  it('errores parciales (algo se resolvió) no son una pasada fallida: no avisa a Sentry (lo vigila el bloque ops del panel)', async () => {
    m.settle.mockResolvedValueOnce({ outcome: 'completed' }).mockResolvedValue({ outcome: 'unknown', reason: 'x' });
    const prisma = (await import('@/lib/prisma')).prisma as unknown as { order: { findMany: ReturnType<typeof vi.fn> } };
    prisma.order.findMany.mockImplementation(async (a: { where?: { status?: string } }) => (a?.where && 'paymentId' in (a.where as object) && (a.where as { paymentId?: unknown }).paymentId ? [m.order, { ...m.order, id: 'cm9otropedido0000000000zz' }] : []));
    const res = await call();
    expect(res.status).toBe(200);
    expect(m.capture).not.toHaveBeenCalled();
  });
});
