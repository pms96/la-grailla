import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { POST as createShopOrder } from '@/app/api/shop/orders/route';
import * as getOrderRoute from '@/app/api/orders/[orderId]/route';
import * as getShopOrderRoute from '@/app/api/shop/orders/[orderId]/route';
import { signOrderAccess, signShopOrderAccess } from '@/lib/access-token';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { syncProductVariants } from '@/lib/product-stock';
import { computeTermsVersion } from '@/lib/legal-terms';

/* P0-11: aceptación de condiciones obligatoria en el SERVIDOR (no solo la casilla), aviso de edad, versión de condiciones guardada con copia,
 * IVA vigente copiado al pedido y datos fiscales en la API del justificante. */

let ipSeq = 0;
const ip = () => `198.51.100.${(ipSeq = (ipSeq % 250) + 1)}`;
const post = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ orderId: id }) });

const KEYS = ['payment_gateway', 'legal_terms_entradas', 'legal_terms_tienda', 'privacy_policy', 'vat_rate_entradas', 'vat_rate_tienda', 'fiscal_nif', 'fiscal_legal_name', 'fiscal_address', 'commission_percentage'] as const;

describe('P0-11: aceptación de condiciones y justificante', () => {
  const originals: Record<string, string | null> = {};
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  const createdSnapshots: string[] = [];

  beforeAll(async () => {
    for (const k of KEYS) originals[k] = await getAndSetConfig(k, k === 'payment_gateway' ? 'mock' : k === 'commission_percentage' ? '0' : '');
    event = await createTestEvent();
    tt = await createTicketType(event.id, { maxQuantity: 50, price: 11 });
  });

  afterAll(async () => {
    for (const k of KEYS) await restoreConfig(k, originals[k]);
    await cleanupTestEvent(event.id);
    await prisma.legalSnapshot.deleteMany({ where: { hash: { in: createdSnapshots } } });
  });

  const orderBody = (over: Record<string, unknown> = {}) => ({
    eventId: event.id,
    buyerName: 'Ana',
    buyerLastName: 'García',
    buyerEmail: `ana-${Math.random().toString(36).slice(2, 7)}@example.com`,
    items: [{ ticketTypeId: tt.id, quantity: 1 }],
    ...over,
  });

  describe('entradas', () => {
    it('sin acceptedTerms: 400 con código, sin crear pedido ni reservar stock', async () => {
      const before = await prisma.ticketType.findUnique({ where: { id: tt.id } });
      const res = await createOrder(post('http://localhost/api/orders', orderBody()));
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe('terms_not_accepted');
      expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(0);
      expect((await prisma.ticketType.findUnique({ where: { id: tt.id } }))?.soldCount).toBe(before?.soldCount);
    });

    it('acceptedTerms=false o un valor no booleano tampoco vale', async () => {
      for (const acceptedTerms of [false, 'true', 1, null]) {
        const res = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms })));
        expect(res.status).toBe(400);
        expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(0);
      }
    });

    it('con la aceptación guarda cuándo y la versión; la copia de los textos existe y es la que vio el comprador', async () => {
      await getAndSetConfig('legal_terms_entradas', 'CONDICIONES V1 de prueba');
      await getAndSetConfig('privacy_policy', 'PRIVACIDAD V1');
      const t0 = Date.now();
      const res = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true })));
      expect(res.status).toBe(200);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: (await res.json()).orderId } });
      expect(order.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
      expect(order.termsVersion).toMatch(/^[0-9a-f]{32}$/);
      expect(order.ageConfirmedAt).toBeNull(); // el evento no tiene aviso de edad
      createdSnapshots.push(order.termsVersion!);
      const snap = await prisma.legalSnapshot.findUniqueOrThrow({ where: { hash: order.termsVersion! } });
      const content = JSON.parse(snap.content);
      expect(content).toMatchObject({ kind: 'entradas', terms: 'CONDICIONES V1 de prueba', privacy: 'PRIVACIDAD V1' });
    });

    it('si el cliente cambia sus condiciones, los pedidos nuevos llevan otra versión y la antigua se conserva', async () => {
      await getAndSetConfig('legal_terms_entradas', 'CONDICIONES V1 de prueba');
      const r1 = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true })));
      const v1 = (await prisma.order.findUniqueOrThrow({ where: { id: (await r1.json()).orderId } })).termsVersion!;
      await getAndSetConfig('legal_terms_entradas', 'CONDICIONES V2 de prueba');
      const r2 = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true })));
      const v2 = (await prisma.order.findUniqueOrThrow({ where: { id: (await r2.json()).orderId } })).termsVersion!;
      createdSnapshots.push(v1, v2);
      expect(v2).not.toBe(v1);
      expect(JSON.parse((await prisma.legalSnapshot.findUniqueOrThrow({ where: { hash: v1 } })).content).terms).toBe('CONDICIONES V1 de prueba');
      expect(JSON.parse((await prisma.legalSnapshot.findUniqueOrThrow({ where: { hash: v2 } })).content).terms).toBe('CONDICIONES V2 de prueba');
    });

    it('sin condiciones propias se registra el borrador por defecto (también se puede demostrar qué se aceptó)', async () => {
      await getAndSetConfig('legal_terms_entradas', '');
      const res = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true })));
      const order = await prisma.order.findUniqueOrThrow({ where: { id: (await res.json()).orderId } });
      createdSnapshots.push(order.termsVersion!);
      const content = JSON.parse((await prisma.legalSnapshot.findUniqueOrThrow({ where: { hash: order.termsVersion! } })).content);
      expect(content.terms).toMatch(/103\.l/);
    });

    it('el tipo de IVA vigente se copia al pedido; cambiarlo después no toca los pedidos ya hechos', async () => {
      await getAndSetConfig('vat_rate_entradas', '10');
      const r1 = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true })));
      const id1 = (await r1.json()).orderId as string;
      await getAndSetConfig('vat_rate_entradas', '21');
      const r2 = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true })));
      const id2 = (await r2.json()).orderId as string;
      expect((await prisma.order.findUniqueOrThrow({ where: { id: id1 } })).vatRate).toBe(10);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: id2 } })).vatRate).toBe(21);
      await getAndSetConfig('vat_rate_entradas', '');
      const r3 = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true })));
      expect((await prisma.order.findUniqueOrThrow({ where: { id: (await r3.json()).orderId } })).vatRate).toBeNull();
    });

    it('si las condiciones cambian entre que se pinta la pantalla y se envía, 409 terms_changed sin crear nada; con la versión vigente pasa', async () => {
      await getAndSetConfig('legal_terms_entradas', 'CONDICIONES VISTAS');
      const seen = (await computeTermsVersion('entradas', '')).hash;
      await getAndSetConfig('legal_terms_entradas', 'CONDICIONES EDITADAS DESPUÉS');
      const before = await prisma.order.count({ where: { eventId: event.id } });
      const stale = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true, termsVersion: seen })));
      expect(stale.status).toBe(409);
      expect((await stale.json()).code).toBe('terms_changed');
      expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(before);
      const fresh = (await computeTermsVersion('entradas', '')).hash;
      const ok = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true, termsVersion: fresh })));
      expect(ok.status).toBe(200);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: (await ok.json()).orderId } });
      expect(order.termsVersion).toBe(fresh);
      createdSnapshots.push(fresh);
    });

    it('sin privacy_policy propia se registra la política de reserva que de verdad se mostró (no un texto vacío)', async () => {
      await getAndSetConfig('privacy_policy', '');
      const res = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true })));
      const order = await prisma.order.findUniqueOrThrow({ where: { id: (await res.json()).orderId } });
      createdSnapshots.push(order.termsVersion!);
      const content = JSON.parse((await prisma.legalSnapshot.findUniqueOrThrow({ where: { hash: order.termsVersion! } })).content);
      expect(content.privacy).toMatch(/tratamos tus datos personales/);
    });

    it('invitaciones y ventas de taquilla no llevan el pie fiscal de venta online', async () => {
      await getAndSetConfig('fiscal_nif', 'B12345678');
      for (const over of [{ channel: 'INVITACION' }, { channel: 'TAQUILLA' }, { paymentMethod: 'FREE' as const }]) {
        const o = await prisma.order.create({ data: { eventId: event.id, buyerName: 'X', buyerLastName: 'Y', buyerEmail: 'x@example.com', totalAmount: 0, status: 'COMPLETED', ...over } });
        const json = await (await getOrderRoute.GET(new Request(`http://localhost/api/orders/${o.id}?t=${encodeURIComponent(signOrderAccess(o.id))}`), params(o.id))).json();
        expect(json.fiscal).toBeNull();
      }
    });

    it('evento con aviso de edad: exige confirmarlo en el servidor (entrando directo a /comprar no se salta) y lo guarda', async () => {
      const aged = await createTestEvent();
      await prisma.event.update({ where: { id: aged.id }, data: { ageWarningEnabled: true, minAge: 18 } });
      const t = await createTicketType(aged.id, { maxQuantity: 10, price: 5 });
      try {
        const body = (over: Record<string, unknown>) => ({ ...orderBody(), eventId: aged.id, items: [{ ticketTypeId: t.id, quantity: 1 }], acceptedTerms: true, ...over });
        const no = await createOrder(post('http://localhost/api/orders', body({})));
        expect(no.status).toBe(400);
        expect((await no.json()).code).toBe('age_not_confirmed');
        const falsy = await createOrder(post('http://localhost/api/orders', body({ ageConfirmed: false })));
        expect(falsy.status).toBe(400);
        expect(await prisma.order.count({ where: { eventId: aged.id } })).toBe(0);
        const yes = await createOrder(post('http://localhost/api/orders', body({ ageConfirmed: true })));
        expect(yes.status).toBe(200);
        const order = await prisma.order.findUniqueOrThrow({ where: { id: (await yes.json()).orderId } });
        expect(order.ageConfirmedAt).not.toBeNull();
        expect(order.termsAcceptedAt).not.toBeNull();
        createdSnapshots.push(order.termsVersion!);
      } finally {
        await cleanupTestEvent(aged.id);
      }
    });

    it('la API del justificante devuelve vendedor e IVA desglosado solo si están configurados, y solo con el pedido pagado', async () => {
      await getAndSetConfig('vat_rate_entradas', '10');
      await getAndSetConfig('fiscal_nif', 'B12345678');
      await getAndSetConfig('fiscal_legal_name', 'Acme Eventos SL');
      await getAndSetConfig('fiscal_address', 'Calle Mayor 1, Málaga');
      const res = await createOrder(post('http://localhost/api/orders', orderBody({ acceptedTerms: true })));
      const id = (await res.json()).orderId as string;
      const json = await (await getOrderRoute.GET(new Request(`http://localhost/api/orders/${id}?t=${encodeURIComponent(signOrderAccess(id))}`), params(id))).json();
      expect(json.fiscal.issuer).toEqual({ name: 'Acme Eventos SL', nif: 'B12345678', address: 'Calle Mayor 1, Málaga' });
      expect(json.fiscal.vat).toEqual({ rate: 10, base: 10, vat: 1, total: 11 });

      await getAndSetConfig('fiscal_nif', '');
      const sinNif = await (await getOrderRoute.GET(new Request(`http://localhost/api/orders/${id}?t=${encodeURIComponent(signOrderAccess(id))}`), params(id))).json();
      expect(sinNif.fiscal.issuer).toBeNull(); // sin NIF no se imprime ningún dato del vendedor

      await prisma.order.update({ where: { id }, data: { status: 'CANCELLED' } });
      const cancelled = await (await getOrderRoute.GET(new Request(`http://localhost/api/orders/${id}?t=${encodeURIComponent(signOrderAccess(id))}`), params(id))).json();
      expect(cancelled.fiscal).toBeNull();
    });
  });

  describe('tienda', () => {
    let productId: string;
    beforeEach(async () => {
      const suffix = `legal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const p = await prisma.product.create({ data: { name: `[TEST] Gorra ${suffix}`, slug: `test-gorra-${suffix}`, price: 20, sizes: 'M', colors: 'Negro', isActive: true } });
      productId = p.id;
      await prisma.$transaction(async (tx) => {
        await syncProductVariants(tx, p.id, p.sizes, p.colors, [{ size: 'M', color: 'Negro', stock: 5 }]);
      });
    });
    afterEach(async () => {
      await prisma.shopOrderItem.deleteMany({ where: { productId } });
      await prisma.shopOrder.deleteMany({ where: { items: { some: { productId } } } });
      await prisma.product.delete({ where: { id: productId } }).catch(() => {});
    });

    const shopBody = (over: Record<string, unknown> = {}) => ({
      buyerName: 'Luis',
      buyerEmail: `luis-${Math.random().toString(36).slice(2, 7)}@example.com`,
      shippingAddress: 'Calle 1',
      shippingCity: 'Madrid',
      shippingZip: '28001',
      items: [{ productId, quantity: 1, size: 'M', color: 'Negro' }],
      ...over,
    });
    const stock = async () => (await prisma.productVariant.findFirstOrThrow({ where: { productId } })).stock;

    it('sin acceptedTerms: 400, sin pedido y sin tocar el stock', async () => {
      const res = await createShopOrder(post('http://localhost/api/shop/orders', shopBody()));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('terms_not_accepted');
      expect(await stock()).toBe(5);
      expect(await prisma.shopOrder.count({ where: { items: { some: { productId } } } })).toBe(0);
    });

    it('con la aceptación guarda cuándo, la versión (con copia) y el IVA; la API del justificante lo desglosa', async () => {
      await getAndSetConfig('legal_terms_tienda', 'TIENDA V1: desistimiento 14 días');
      await getAndSetConfig('vat_rate_tienda', '21');
      await getAndSetConfig('fiscal_nif', 'B12345678');
      const res = await createShopOrder(post('http://localhost/api/shop/orders', shopBody({ acceptedTerms: true })));
      expect(res.status).toBe(200);
      const id = (await res.json()).orderId as string;
      const order = await prisma.shopOrder.findUniqueOrThrow({ where: { id } });
      expect(order.termsAcceptedAt).not.toBeNull();
      expect(order.vatRate).toBe(21);
      createdSnapshots.push(order.termsVersion!);
      const content = JSON.parse((await prisma.legalSnapshot.findUniqueOrThrow({ where: { hash: order.termsVersion! } })).content);
      expect(content).toMatchObject({ kind: 'tienda', terms: 'TIENDA V1: desistimiento 14 días' });

      const view = await (await getShopOrderRoute.GET(new Request(`http://localhost/api/shop/orders/${id}?t=${encodeURIComponent(signShopOrderAccess(id))}`), params(id))).json();
      expect(view.fiscal.vat).toEqual({ rate: 21, base: 16.53, vat: 3.47, total: 20 });
      expect(view.fiscal.issuer.nif).toBe('B12345678');
    });
  });
});
