import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as reconcileGateway } from '@/app/api/cron/reconcile-gateway/route';
import { runGatewayReconciliation, GATEWAY_MIN_AGE_MS, GATEWAY_WINDOW_MS, GATEWAY_SUMUP_ORDER_CAP } from '@/lib/reconciliation/gateway';
import { OPS_GATEWAY_KEY, collectOps, parseGatewaySummary } from '@/lib/ops-health';
import type { PaidByReference, PaidListing, PaidSession, PaymentProvider, PaymentResult } from '@/lib/payment-adapter';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

/* OB-11 · alerta nº 1: conciliación inversa pasarela → BD. Pasarela falsa (sin red) y BD real. */

const ctl = vi.hoisted(() => ({
  fingerprint: { entradas: 'stripe:aaaa' as string | null, tienda: 'stripe:aaaa' as string | null },
  provider: null as unknown,
  throwProvider: false,
  alerts: [] as { reason: string; dedupeKey?: string; kind: string; orderId: string; html: string; details?: Record<string, unknown> }[],
}));

vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  return {
    ...actual,
    paymentAccountFingerprint: async (scope: 'entradas' | 'tienda') => ctl.fingerprint[scope],
    getPaymentProvider: async () => {
      if (ctl.throwProvider) throw new Error('credencial ilegible');
      return ctl.provider;
    },
  };
});
vi.mock('@/lib/reconciliation/shared', async (orig) => {
  const actual = await orig<typeof import('@/lib/reconciliation/shared')>();
  return { ...actual, alertOperator: async (p: (typeof ctl.alerts)[number]) => void ctl.alerts.push(p) };
});

const NOW = Date.now();
const mins = (n: number) => new Date(NOW - n * 60_000);

function session(over: Partial<PaidSession> & { id: string }): PaidSession {
  return { orderId: `ord_${over.id}`, orderType: 'ticket', amount: 10, currency: 'EUR', createdAt: mins(300), refunded: false, ...over };
}

function stripeFake(listing: PaidListing | Error) {
  const calls: { from: Date; to: Date; maxPages: number }[] = [];
  const provider = {
    name: 'stripe',
    capabilities: {},
    async listRecentPaid(opts: { from: Date; to: Date; maxPages: number; deadline: number }) {
      calls.push(opts);
      if (listing instanceof Error) throw listing;
      return listing;
    },
  } as unknown as PaymentProvider;
  return { provider, calls };
}

function sumupFake(opts: { verify: Record<string, PaymentResult['status']>; byRef?: Record<string, PaidByReference> }) {
  const refs: string[] = [];
  const provider = {
    name: 'sumup',
    capabilities: {},
    async verifyPayment(paymentId: string): Promise<PaymentResult> {
      const status = opts.verify[paymentId] ?? 'UNKNOWN';
      return { success: status === 'PAID', paymentId, provider: 'sumup', status, ...(status === 'UNKNOWN' ? { error: 'x' } : {}) };
    },
    async findPaidByReference(reference: string): Promise<PaidByReference> {
      refs.push(reference);
      return opts.byRef?.[reference] ?? { paid: false, refunded: false };
    },
  } as unknown as PaymentProvider;
  return { provider, refs };
}

describe('conciliación diaria pasarela → BD (OB-11)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const shopIds: string[] = [];

  const makeOrder = async (id: string, status: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED', paymentId: string | null, over: { createdAt?: Date; provider?: string } = {}) => {
    const o = await prisma.order.create({
      data: { id, eventId: event.id, buyerName: 'G', buyerLastName: 'W', buyerEmail: `${id}@example.com`, totalAmount: 10, status, paymentId, paymentProvider: over.provider ?? 'stripe' },
    });
    if (over.createdAt) await prisma.order.update({ where: { id: o.id }, data: { createdAt: over.createdAt } });
  };
  const makeShop = async (id: string, status: 'PENDING' | 'PAID' | 'CANCELLED', paymentId: string | null, over: { createdAt?: Date; provider?: string } = {}) => {
    shopIds.push(id);
    const o = await prisma.shopOrder.create({
      data: { id, buyerName: 'S', buyerEmail: `${id}@example.com`, shippingAddress: 'x', shippingCity: 'x', shippingZip: '1', totalAmount: 20, status, paymentId, paymentProvider: over.provider ?? 'stripe' },
    });
    if (over.createdAt) await prisma.shopOrder.update({ where: { id: o.id }, data: { createdAt: over.createdAt } });
  };

  beforeAll(async () => {
    event = await createTestEvent();
    tt = await createTicketType(event.id, { maxQuantity: 50 });
    void tt;
  });
  beforeEach(() => {
    ctl.fingerprint = { entradas: 'stripe:aaaa', tienda: 'stripe:aaaa' };
    ctl.throwProvider = false;
    ctl.alerts.length = 0;
  });
  afterEach(async () => {
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.shopOrder.deleteMany({ where: { id: { in: shopIds.splice(0) } } });
    await prisma.appConfig.deleteMany({ where: { key: OPS_GATEWAY_KEY } });
  });
  afterAll(async () => {
    await cleanupTestEvent(event.id);
  });

  describe('Stripe (sentido pasarela → BD)', () => {
    it('clasifica cada cobro: pedido pagado = bien; sin pedido y sin confirmar = incidente; reembolsado o sin metadata (no es de esta plataforma) = ignorados', async () => {
      await makeOrder('ord_A', 'COMPLETED', 'cs_A'); // bien, por paymentId
      await makeOrder('ord_G', 'COMPLETED', null); // bien, por el id de la metadata (el pedido nunca guardó el paymentId)
      await makeOrder('ord_C', 'PENDING', 'cs_C'); // cobrado y sin confirmar
      await makeOrder('ord_J', 'CANCELLED', 'cs_J'); // cobrado y el pedido está cancelado
      await makeOrder('ord_K', 'REFUNDED', 'cs_K'); // devuelto: bien
      await makeShop('shop_H', 'PAID', 'cs_H'); // bien (tienda)
      await makeShop('shop_I', 'CANCELLED', 'cs_I'); // incidente (tienda)
      const { provider, calls } = stripeFake({
        truncated: false,
        sessions: [
          session({ id: 'cs_A' }),
          session({ id: 'cs_G', orderId: 'ord_G' }),
          session({ id: 'cs_B' }), // sin pedido
          session({ id: 'cs_C' }),
          session({ id: 'cs_J' }),
          session({ id: 'cs_K' }),
          session({ id: 'cs_D', refunded: true }), // reembolsado: el dinero volvió
          session({ id: 'cs_F', orderId: null }), // no es de esta plataforma
          session({ id: 'cs_H', orderId: 'shop_H', orderType: 'shop', amount: 20 }),
          session({ id: 'cs_I', orderId: 'shop_I', orderType: 'shop', amount: 20 }),
        ],
      });
      ctl.provider = provider;

      const { summary, samples } = await runGatewayReconciliation({ now: NOW });

      expect(samples.map((s) => `${s.reason}:${s.gatewayId}:${s.kind}`).sort()).toEqual([
        'no_order:cs_B:entradas',
        'order_not_confirmed:cs_C:entradas',
        'order_not_confirmed:cs_I:tienda',
        'order_not_confirmed:cs_J:entradas',
      ]);
      expect(summary).toMatchObject({ unmatched: 4, errors: 0, skipped: 0, truncated: false });
      expect(summary.checked).toBe(8); // los 10 menos el sin metadata y el reembolsado
      // Solo se miran cobros de entre 48 h y 45 min atrás: lo reciente aún está en el flujo normal.
      expect(calls).toHaveLength(1); // misma cuenta para Entradas y Tienda: se recorre UNA vez
      expect(calls[0].to.getTime()).toBe(NOW - GATEWAY_MIN_AGE_MS);
      expect(calls[0].from.getTime()).toBe(NOW - GATEWAY_WINDOW_MS);
    });

    it('guarda el resultado para el health (`ops.gateway`) y avisa al operador UNA vez con un conjunto estable', async () => {
      ctl.provider = stripeFake({ truncated: false, sessions: [session({ id: 'cs_B' }), session({ id: 'cs_X', orderId: 'ord_X' })] }).provider;
      await runGatewayReconciliation({ now: NOW });
      await runGatewayReconciliation({ now: NOW + 60_000 });

      const stored = parseGatewaySummary((await prisma.appConfig.findUnique({ where: { key: OPS_GATEWAY_KEY } }))?.value);
      expect(stored).toMatchObject({ checked: 2, unmatched: 2, errors: 0 });
      const ops = await collectOps(NOW);
      expect(ops?.gateway).toMatchObject({ unmatched: 2 });

      expect(ctl.alerts).toHaveLength(2); // una por pasada; alertOperator limita a una al día por dedupeKey
      expect(ctl.alerts[0].reason).toBe('paid_without_order');
      expect(ctl.alerts[0].dedupeKey).toBe(ctl.alerts[1].dedupeKey); // mismo conjunto = mismo aviso del día
      expect(ctl.alerts[0].html).toContain('cs_B');
      expect(ctl.alerts[0].html).not.toMatch(/@/); // sin datos del comprador
    });

    it('un cobro NUEVO sin pedido cambia el conjunto y por tanto avisa en el momento', async () => {
      ctl.provider = stripeFake({ truncated: false, sessions: [session({ id: 'cs_B' })] }).provider;
      await runGatewayReconciliation({ now: NOW });
      ctl.provider = stripeFake({ truncated: false, sessions: [session({ id: 'cs_B' }), session({ id: 'cs_N' })] }).provider;
      await runGatewayReconciliation({ now: NOW });
      expect(ctl.alerts[0].dedupeKey).not.toBe(ctl.alerts[1].dedupeKey);
    });

    it('todo cuadra: 0 incidentes, sin aviso', async () => {
      await makeOrder('ord_A', 'COMPLETED', 'cs_A');
      ctl.provider = stripeFake({ truncated: false, sessions: [session({ id: 'cs_A' })] }).provider;
      const { summary } = await runGatewayReconciliation({ now: NOW });
      expect(summary).toMatchObject({ checked: 1, unmatched: 0, errors: 0 });
      expect(ctl.alerts).toHaveLength(0);
    });

    it('la consulta a la pasarela falla (clave inválida): cuenta como error, no como «todo bien», y no hay falso incidente', async () => {
      ctl.provider = stripeFake({ truncated: false, sessions: [], error: 'Invalid API Key' }).provider;
      const { summary } = await runGatewayReconciliation({ now: NOW });
      expect(summary).toMatchObject({ checked: 0, unmatched: 0, errors: 1 });
      ctl.provider = stripeFake(new Error('boom')).provider;
      expect((await runGatewayReconciliation({ now: NOW })).summary.errors).toBe(1);
      ctl.throwProvider = true;
      expect((await runGatewayReconciliation({ now: NOW })).summary.errors).toBe(1); // credencial ilegible
      expect(ctl.alerts).toHaveLength(0);
    });

    it('una lista cortada por el tope de páginas se marca `truncated` (puede haber más cobros sin mirar)', async () => {
      ctl.provider = stripeFake({ truncated: true, sessions: [] }).provider;
      expect((await runGatewayReconciliation({ now: NOW })).summary.truncated).toBe(true);
    });

    it('Entradas y Tienda con cuentas DISTINTAS recorren cada una la suya', async () => {
      ctl.fingerprint = { entradas: 'stripe:aaaa', tienda: 'stripe:bbbb' };
      const f = stripeFake({ truncated: false, sessions: [] });
      ctl.provider = f.provider;
      await runGatewayReconciliation({ now: NOW });
      expect(f.calls).toHaveLength(2);
    });

    it('sin pasarela real (simulada o sin configurar): no hay nada que conciliar ni error', async () => {
      ctl.fingerprint = { entradas: null, tienda: null };
      ctl.provider = stripeFake({ truncated: false, sessions: [session({ id: 'cs_B' })] }).provider;
      const { summary } = await runGatewayReconciliation({ now: NOW });
      expect(summary).toMatchObject({ checked: 0, unmatched: 0, errors: 0, skipped: 0 });
    });
  });

  describe('SumUp (solo se puede mirar BD → pasarela)', () => {
    beforeEach(() => {
      ctl.fingerprint = { entradas: 'sumup:aaaa', tienda: null };
    });

    it('pedidos sin pagar cuyo checkout SÍ está pagado son incidente; los demás no; se anota la cobertura parcial', async () => {
      await makeOrder('ord_P', 'PENDING', 'co_P', { provider: 'sumup', createdAt: mins(120) }); // pagado y sin confirmar
      await makeOrder('ord_E', 'CANCELLED', 'co_E', { provider: 'sumup', createdAt: mins(300) }); // caducado de verdad: bien
      await makeOrder('ord_R', 'CANCELLED', 'co_R', { provider: 'sumup', createdAt: mins(300) }); // reembolsado: bien
      await makeOrder('ord_N', 'PENDING', null, { provider: 'sumup', createdAt: mins(300) }); // sin paymentId y pagado
      await makeOrder('ord_M', 'PENDING', null, { provider: 'sumup', createdAt: mins(300) }); // sin paymentId y sin pagar
      await makeOrder('ord_Q', 'PENDING', 'co_Q', { provider: 'sumup', createdAt: mins(10) }); // demasiado reciente: no se juzga
      await makeOrder('ord_Z', 'CANCELLED', 'co_Z', { provider: 'sumup', createdAt: new Date(NOW - 60 * 3_600_000) }); // fuera de las 48 h
      await makeOrder('ord_S', 'CANCELLED', 'co_S', { provider: 'stripe', createdAt: mins(300) }); // de otra pasarela
      const f = sumupFake({
        verify: { co_P: 'PAID', co_E: 'EXPIRED', co_R: 'REFUNDED', co_Q: 'PAID', co_Z: 'PAID', co_S: 'PAID' },
        byRef: { ord_N: { paid: true, checkoutId: 'co_N', refunded: false }, ord_M: { paid: false, refunded: false } },
      });
      ctl.provider = f.provider;

      const { summary, samples } = await runGatewayReconciliation({ now: NOW });

      expect(samples.map((s) => `${s.reason}:${s.orderId}`).sort()).toEqual(['order_not_confirmed:ord_P', 'paid_reference_without_id:ord_N']);
      expect(summary).toMatchObject({ unmatched: 2, errors: 0, skipped: 1, checked: 5 });
      expect(f.refs.sort()).toEqual(['ord_M', 'ord_N']); // la búsqueda por referencia solo para los que nunca guardaron su cobro
      expect(ctl.alerts).toHaveLength(1);
    });

    it('tienda: un pedido cuyo cobro nunca se guardó (proveedor y paymentId nulos) también se contrasta por referencia', async () => {
      ctl.fingerprint = { entradas: null, tienda: 'sumup:bbbb' };
      await makeShop('shop_nopid', 'PENDING', null, { provider: undefined, createdAt: mins(300) });
      await prisma.shopOrder.update({ where: { id: 'shop_nopid' }, data: { paymentProvider: null } });
      const f = sumupFake({ verify: {}, byRef: { shop_nopid: { paid: true, checkoutId: 'co_shop', refunded: false } } });
      ctl.provider = f.provider;
      const { samples } = await runGatewayReconciliation({ now: NOW });
      expect(samples.map((s) => `${s.reason}:${s.kind}:${s.orderId}`)).toEqual(['paid_reference_without_id:tienda:shop_nopid']);
    });

    it('una verificación que falla (UNKNOWN) es un error de la conciliación, no un incidente ni un «bien»', async () => {
      await makeOrder('ord_U', 'CANCELLED', 'co_U', { provider: 'sumup', createdAt: mins(300) });
      ctl.provider = sumupFake({ verify: { co_U: 'UNKNOWN' } }).provider;
      const { summary } = await runGatewayReconciliation({ now: NOW });
      expect(summary).toMatchObject({ unmatched: 0, errors: 1, checked: 0 });
    });

    it(`más de ${GATEWAY_SUMUP_ORDER_CAP} candidatos: se mira el tope y se marca truncated`, async () => {
      const rows = Array.from({ length: GATEWAY_SUMUP_ORDER_CAP + 5 }, (_, i) => ({
        id: `ord_cap_${i}`, eventId: event.id, buyerName: 'G', buyerLastName: 'W', buyerEmail: `cap${i}@example.com`, totalAmount: 10, status: 'CANCELLED' as const, paymentId: `co_cap_${i}`, paymentProvider: 'sumup', createdAt: mins(300),
      }));
      await prisma.order.createMany({ data: rows });
      ctl.provider = sumupFake({ verify: {} }).provider;
      const { summary } = await runGatewayReconciliation({ now: NOW, deadline: NOW + 60_000 });
      expect(summary.truncated).toBe(true);
    });
  });

  describe('ruta del cron', () => {
    const SECRET = 'test-cron-secret';
    const original = process.env.CRON_SECRET;
    beforeAll(() => void (process.env.CRON_SECRET = SECRET));
    afterAll(() => void (process.env.CRON_SECRET = original));
    const call = (secret: string | null) => reconcileGateway(new Request('http://localhost/api/cron/reconcile-gateway', { headers: secret ? { Authorization: `Bearer ${secret}` } : {} }));

    it('sin secreto o con uno malo: 401', async () => {
      expect((await call(null)).status).toBe(401);
      expect((await call('otro')).status).toBe(401);
    });

    it('con el secreto: 200 con el resumen y los casos (sin datos del comprador)', async () => {
      ctl.provider = stripeFake({ truncated: false, sessions: [session({ id: 'cs_B' })] }).provider;
      const res = await call(SECRET);
      expect(res.status).toBe(200); // un cobro sin pedido es un hallazgo, no un fallo de la tarea
      const json = await res.json();
      expect(json).toMatchObject({ unmatched: 1, checked: 1, errors: 0 });
      expect(JSON.stringify(json)).not.toMatch(/@example|buyer/i);
    });

    it('502 solo si no se pudo mirar NINGUNA cuenta (así el panel lo cuenta como fallo y reintenta)', async () => {
      ctl.provider = stripeFake({ truncated: false, sessions: [], error: 'Invalid API Key' }).provider;
      expect((await call(SECRET)).status).toBe(502);
    });
  });
});

describe('parseGatewaySummary', () => {
  it('lee un resumen válido y descarta lo raro (nunca propaga texto de la BD)', () => {
    const ok = { lastRunAt: '2026-10-27T10:00:00.000Z', checked: 3, unmatched: 1, errors: 0, skipped: 0, truncated: false };
    expect(parseGatewaySummary(JSON.stringify(ok))).toEqual(ok);
    for (const bad of [null, '', 'no json', '{}', JSON.stringify({ ...ok, unmatched: -1 }), JSON.stringify({ ...ok, lastRunAt: 'ayer' }), JSON.stringify({ ...ok, checked: '3' })]) {
      expect(parseGatewaySummary(bad as string | null)).toBeNull();
    }
  });
});
