import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { encryptSecret, SECRET_MASK } from '@/lib/secrets';
import { SHOP_ACCOUNT_SINCE_KEY } from '@/lib/config';
import { accountScopeForOrder } from '@/lib/payment-adapter';
import { closeSessionBeforeCancel } from '@/lib/reconciliation/close-session';
import { invalidateShopOrder } from '@/lib/reconciliation/tienda';
import { settleUnpaidOrder } from '@/lib/reconciliation/settle';

const rec = vi.hoisted(() => ({ scopes: [] as string[], stripeKeys: [] as string[] }));

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'shop-account-admin', role: 'ADMIN', modules: null } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { fakeProvider } = await import('../helpers/fake-gateway');
  return {
    ...actual,
    // Registra con qué cuenta se pide el adaptador (lo que se comprueba) y devuelve la pasarela falsa.
    getPaymentProviderByName: async (_name: string, scope?: string) => {
      rec.scopes.push(scope ?? 'entradas');
      return fakeProvider();
    },
    StripeAdapter: class {
      constructor(key: string) {
        rec.stripeKeys.push(key);
      }
      async testConnection() {
        return { ok: true };
      }
    },
  };
});

const { PUT: putConfig } = await import('@/app/api/admin/config/route');
const { POST: testGateway } = await import('@/app/api/admin/config/test-gateway/route');

/* P1-11 / TI-10 / TI-11: «Probar conexión» de la Tienda prueba la cuenta de la Tienda, y un pedido de tienda cobrado ANTES de que la tienda tuviera
 * cuenta propia sigue verificándose y reembolsándose con la cuenta de Entradas con la que se cobró. */

const KEYS = ['shop_payment_gateway', SHOP_ACCOUNT_SINCE_KEY, 'stripe_secret_key', 'shop_stripe_secret_key'];

describe('cuenta de cobro de la tienda (P1-11)', () => {
  let saved: { key: string; value: string; label: string | null; group: string | null }[] = [];
  const orderIds: string[] = [];

  beforeAll(async () => {
    saved = await prisma.appConfig.findMany({ where: { key: { in: KEYS } }, select: { key: true, value: true, label: true, group: true } });
    await prisma.appConfig.deleteMany({ where: { key: { in: KEYS } } });
  });
  afterAll(async () => {
    await prisma.shopOrder.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.appConfig.deleteMany({ where: { key: { in: KEYS } } });
    for (const row of saved) await prisma.appConfig.create({ data: row });
  });
  beforeEach(async () => {
    rec.scopes = [];
    rec.stripeKeys = [];
    await prisma.appConfig.deleteMany({ where: { key: { in: KEYS } } });
  });

  const setSince = (ms: number) => prisma.appConfig.create({ data: { key: SHOP_ACCOUNT_SINCE_KEY, value: String(ms), label: SHOP_ACCOUNT_SINCE_KEY, group: 'system' } });
  async function shopOrder(createdAt: Date, status: 'PAID' | 'PENDING' = 'PAID') {
    const o = await prisma.shopOrder.create({
      data: {
        buyerName: '[TEST] Cuenta', buyerEmail: 'cuenta-p111@example.com', shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001',
        totalAmount: 20, status, paymentProvider: 'stripe', paymentId: `cs_p111_${Math.random().toString(36).slice(2, 8)}`, createdAt,
      },
    });
    orderIds.push(o.id);
    return o;
  }

  describe('qué cuenta le toca a un pedido', () => {
    it('sin cambio de cuenta registrado, la de la tienda (como siempre)', async () => {
      expect(await accountScopeForOrder('tienda', { createdAt: new Date(0) })).toBe('tienda');
    });

    it('un pedido anterior al cambio es de la cuenta de Entradas; uno posterior, de la de la tienda; Entradas, siempre la suya', async () => {
      const since = Date.now() - 3600_000;
      await setSince(since);
      expect(await accountScopeForOrder('tienda', { createdAt: new Date(since - 1000) })).toBe('entradas');
      expect(await accountScopeForOrder('tienda', { createdAt: new Date(since + 1000) })).toBe('tienda');
      expect(await accountScopeForOrder('entradas', { createdAt: new Date(since - 1000) })).toBe('entradas');
      expect(await accountScopeForOrder('tienda', {})).toBe('tienda'); // sin fecha de pedido no se adivina
    });
  });

  describe('reembolso y cierre de sesión con la cuenta correcta', () => {
    it('reembolsar un pedido cobrado antes del cambio usa la cuenta de Entradas; uno cobrado después, la de la tienda', async () => {
      const since = Date.now() - 3600_000;
      await setSince(since);
      const before = await shopOrder(new Date(since - 60_000));
      const after = await shopOrder(new Date(since + 60_000));
      expect((await invalidateShopOrder(before.id, 'REFUNDED')).success).toBe(true);
      expect(rec.scopes).toEqual(['entradas']);
      expect((await invalidateShopOrder(after.id, 'REFUNDED')).success).toBe(true);
      expect(rec.scopes).toEqual(['entradas', 'tienda']);
    });

    it('anular un pedido pendiente de la cuenta vieja cierra su sesión en la cuenta vieja', async () => {
      const since = Date.now() - 3600_000;
      await setSince(since);
      const old = await shopOrder(new Date(since - 60_000), 'PENDING');
      await closeSessionBeforeCancel('tienda', old);
      expect(rec.scopes).toEqual(['entradas']);
    });

    it('revisión P1-11: el cron (settleUnpaidOrder) verifica un pedido anterior al cambio con la cuenta de Entradas y uno posterior con la de la tienda', async () => {
      const since = Date.now() - 3600_000;
      await setSince(since);
      const old = await shopOrder(new Date(since - 60_000), 'PENDING');
      const fresh = await shopOrder(new Date(since + 60_000), 'PENDING');
      await settleUnpaidOrder({ kind: 'tienda', order: old });
      expect(rec.scopes).toEqual(['entradas']);
      await settleUnpaidOrder({ kind: 'tienda', order: fresh });
      expect(rec.scopes).toEqual(['entradas', 'tienda']);
    });

    it('sin cambio de cuenta registrado, todo sigue en la cuenta de la tienda', async () => {
      const o = await shopOrder(new Date(Date.now() - 86_400_000));
      await invalidateShopOrder(o.id, 'REFUNDED');
      expect(rec.scopes).toEqual(['tienda']);
    });
  });

  describe('guardado de la configuración', () => {
    const save = (configs: { key: string; value: string }[]) => putConfig(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ configs }) }));
    const sinceValue = async () => (await prisma.appConfig.findUnique({ where: { key: SHOP_ACCOUNT_SINCE_KEY } }))?.value ?? null;

    it('la primera vez que la tienda guarda su pasarela se anota la fecha del cambio, y solo esa vez', async () => {
      const t0 = Date.now();
      expect(await sinceValue()).toBeNull();
      expect((await save([{ key: 'shop_payment_gateway', value: 'mock' }])).status).toBe(200);
      const first = Number(await sinceValue());
      expect(first).toBeGreaterThanOrEqual(t0);
      await new Promise((r) => setTimeout(r, 15));
      expect((await save([{ key: 'shop_payment_gateway', value: 'stripe' }])).status).toBe(200);
      expect(Number(await sinceValue())).toBe(first); // no se mueve al volver a guardar
    });

    it('revisión P1-11: un cliente que YA había guardado la pasarela de la tienda no recibe fecha de corte (si no, todos sus pedidos antiguos pasarían a la cuenta de Entradas)', async () => {
      await prisma.appConfig.create({ data: { key: 'shop_payment_gateway', value: 'stripe', label: 'shop_payment_gateway', group: 'tienda' } });
      expect((await save([{ key: 'shop_payment_gateway', value: 'sumup' }])).status).toBe(200);
      expect(await sinceValue()).toBeNull();
    });

    it('guardar otra cosa no anota ningún cambio de cuenta', async () => {
      expect((await save([{ key: 'footer_tagline', value: 'Hola' }])).status).toBe(200);
      expect(await sinceValue()).toBeNull();
      await prisma.appConfig.deleteMany({ where: { key: 'footer_tagline' } });
    });

    it('la fila interna del cambio de cuenta no se puede editar desde el formulario', async () => {
      const res = await save([{ key: SHOP_ACCOUNT_SINCE_KEY, value: '1' }]);
      expect(res.status).toBe(200);
      expect((await res.json()).ignored).toContain(SHOP_ACCOUNT_SINCE_KEY);
      expect(await sinceValue()).toBeNull();
    });
  });

  describe('«Probar conexión»', () => {
    const test = (body: unknown) => testGateway(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }));
    const seedKeys = async () => {
      await prisma.appConfig.createMany({
        data: [
          { key: 'stripe_secret_key', value: encryptSecret('sk_test_ENTRADAS', 'stripe_secret_key'), label: 'x', group: 'entradas' },
          { key: 'shop_stripe_secret_key', value: encryptSecret('sk_test_TIENDA', 'shop_stripe_secret_key'), label: 'x', group: 'tienda' },
        ],
      });
    };

    it('desde la pestaña Tienda, con la clave enmascarada, prueba la clave guardada DE LA TIENDA', async () => {
      await seedKeys();
      const res = await test({ gateway: 'stripe', scope: 'tienda', secretKey: SECRET_MASK });
      expect((await res.json()).ok).toBe(true);
      expect(rec.stripeKeys).toEqual(['sk_test_TIENDA']);
    });

    it('desde Entradas (o sin indicar cuenta, como antes) prueba la de Entradas', async () => {
      await seedKeys();
      await test({ gateway: 'stripe', scope: 'entradas', secretKey: SECRET_MASK });
      await test({ gateway: 'stripe', secretKey: SECRET_MASK });
      expect(rec.stripeKeys).toEqual(['sk_test_ENTRADAS', 'sk_test_ENTRADAS']);
    });

    it('si la tienda aún no tiene clave propia no se «aprueba» con la de Entradas: dice que falta', async () => {
      await prisma.appConfig.create({ data: { key: 'stripe_secret_key', value: encryptSecret('sk_test_ENTRADAS', 'stripe_secret_key'), label: 'x', group: 'entradas' } });
      const res = await test({ gateway: 'stripe', scope: 'tienda', secretKey: SECRET_MASK });
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/Falta/);
      expect(rec.stripeKeys).toEqual([]);
    });

    it('una clave recién escrita en el formulario se prueba tal cual, sea cual sea la cuenta', async () => {
      await test({ gateway: 'stripe', scope: 'tienda', secretKey: '  sk_test_NUEVA  ' });
      expect(rec.stripeKeys).toEqual(['sk_test_NUEVA']);
    });
  });
});
