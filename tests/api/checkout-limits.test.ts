import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/prisma';
import { POST as createOrder } from '@/app/api/orders/route';
import { POST as createShopOrder } from '@/app/api/shop/orders/route';
import { completeOrder } from '@/lib/reconciliation/entradas';
import { completeShopOrder } from '@/lib/reconciliation/tienda';
import { verifyOrderAccess, verifyShopOrderAccess } from '@/lib/access-token';
import { MAX_PENDING_ORDERS_PER_IP, MAX_TICKETS_PER_TYPE, normalizeEmailForLimit, parsePendingLimit } from '@/lib/checkout-limits';
import { invalidateOrder } from '@/lib/reconciliation/entradas';
import { invalidateShopOrder } from '@/lib/reconciliation/tienda';
import { cartMatchesOrderItems, type CartLine } from '@/lib/shop-cart';
import { createTestEvent, createTicketType, cleanupTestEvent, getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { gateway, paid } from '../helpers/fake-gateway';

vi.mock('@/lib/payment-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/payment-adapter')>();
  const { gateway: g, fakeProvider } = await import('../helpers/fake-gateway');
  return {
    ...actual,
    getPaymentProviderByName: async (n: string, s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProviderByName(n, s)),
    getPaymentProvider: async (s?: 'entradas' | 'tienda') => (g.active ? fakeProvider() : actual.getPaymentProvider(s)),
  };
});
vi.mock('@/lib/mailer', async (orig) => ({ ...(await orig<typeof import('@/lib/mailer')>()), sendMail: async () => ({ success: true, transport: 'smtp' as const }) }));

/* P0-04: topes en SERVIDOR (por tipo, por pedido, por IP, por email normalizado), cancelUrl hacia la ruta de abandono, reintento que devuelve
 * la sesión viva y carrito de tienda que no se borra antes de pagar. */

const post = (handler: (r: Request) => Promise<Response>, body: unknown, ip: string) =>
  handler(new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ acceptedTerms: true, ...(body as object) }) }));

/** Tope de pedidos pendientes por IP con el que se ejecutan estos tests (por configuración: el valor por defecto es 10 y el límite por minuto también). */
const CAP = 3;

describe('topes de compra (P0-04)', () => {
  let originalCap: string | null;
  let originalShopCap: string | null;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let tt: Awaited<ReturnType<typeof createTicketType>>;
  let tt2: Awaited<ReturnType<typeof createTicketType>>;
  const productIds: string[] = [];
  let ipCounter = 0;
  /** Una IP distinta por test Y por ejecución: el límite por minuto vive en la BD y sobrevive entre ejecuciones seguidas de la suite. */
  const runId = Math.floor(Math.random() * 60_000);
  const freshIp = () => `10.${runId >> 8}.${runId & 255}.${(ipCounter += 1)}`;

  beforeAll(async () => {
    originalCap = await getAndSetConfig('orders_max_pending_per_ip', String(CAP));
    originalShopCap = await getAndSetConfig('shop_orders_max_pending_per_ip', String(CAP));
    event = await createTestEvent({ maxCapacity: 500 });
    tt = await createTicketType(event.id, { maxQuantity: 500 });
    tt2 = await createTicketType(event.id, { maxQuantity: 500 });
  });
  afterAll(async () => {
    await restoreConfig('orders_max_pending_per_ip', originalCap);
    await restoreConfig('shop_orders_max_pending_per_ip', originalShopCap);
    await prisma.shopOrder.deleteMany({ where: { items: { some: { productId: { in: productIds } } } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'pending:' } } });
  });
  beforeEach(async () => {
    gateway.reset();
    gateway.active = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await prisma.ticket.deleteMany({ where: { eventId: event.id } });
    await prisma.order.deleteMany({ where: { eventId: event.id } });
    await prisma.ticketType.updateMany({ where: { eventId: event.id }, data: { soldCount: 0 } });
    await prisma.event.update({ where: { id: event.id }, data: { maxTicketsPerEmail: null } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'pending:' } } });
  });
  afterEach(() => vi.restoreAllMocks());

  const body = (items: { ticketTypeId: string; quantity: number }[], over: Record<string, unknown> = {}) => ({
    eventId: event.id, buyerName: 'Ana', buyerLastName: 'López', buyerEmail: `ana-${Math.random()}@example.com`, items, ...over,
  });

  describe('entradas: topes por tipo y por pedido', () => {
    it('el tope es el mismo que el de la UI y está en una constante compartida', () => {
      expect(MAX_TICKETS_PER_TYPE).toBe(10);
      const form = fs.readFileSync(path.join(process.cwd(), 'app/(public)/eventos/[slug]/comprar/_components/buy-tickets-form.tsx'), 'utf8');
      expect(form).toContain('MAX_TICKETS_PER_TYPE');
      expect(form).not.toMatch(/Math\.min\(available, 10\)/);
    });

    it('10 de un tipo se acepta; 11 en una línea se rechaza (400) sin crear nada', async () => {
      const ok = await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 10 }]), freshIp());
      expect(ok.status).toBe(200);
      const ko = await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 11 }]), freshIp());
      expect(ko.status).toBe(400);
      expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(1);
    });

    it('el mismo tipo repartido en varias líneas también suma contra el tope (6 + 6 = 12 → 400)', async () => {
      const res = await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 6 }, { ticketTypeId: tt.id, quantity: 6 }]), freshIp());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Máximo 10/);
      expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(0);
    });

    it('10 de un tipo y 10 de otro en el mismo pedido sigue permitido (el tope es por tipo)', async () => {
      const res = await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 10 }, { ticketTypeId: tt2.id, quantity: 10 }]), freshIp());
      expect(res.status).toBe(200);
    });

    it('más de 20 líneas en un pedido se rechaza (400)', async () => {
      const items = Array.from({ length: 21 }, () => ({ ticketTypeId: tt.id, quantity: 1 }));
      expect((await post(createOrder, body(items), freshIp())).status).toBe(400);
    });
  });

  describe('entradas: cupo de pedidos PENDIENTES por IP y evento', () => {
    it(`el ${CAP + 1}º pedido sin pagar desde la misma IP para el mismo evento da 429; otra IP no se ve afectada`, async () => {
      const ip = freshIp();
      for (let i = 0; i < CAP; i++) expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(200);
      const blocked = await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBeTruthy();
      expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(CAP); // el rechazado no reservó nada
      expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), freshIp())).status).toBe(200);
    });

    it('el cupo se libera al PAGAR un pedido (una wifi compartida puede seguir comprando) y al liberarse por caducidad', async () => {
      const ip = freshIp();
      const ids: string[] = [];
      for (let i = 0; i < CAP; i++) ids.push((await (await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).json()).orderId);
      expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(429);

      const first = await prisma.order.findUnique({ where: { id: ids[0] } });
      gateway.script(first!.paymentId!, paid(first!.paymentId!));
      await completeOrder(ids[0]);
      expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(200); // hueco liberado
      expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(429);

      const { releaseExpiredOrder } = await import('@/lib/reconciliation/entradas');
      await releaseExpiredOrder(ids[1]);
      expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(200);
    });

    it('un fallo de la pasarela al crear la sesión libera el cupo (no queda ocupado por un pedido que no existe)', async () => {
      const ip = freshIp();
      gateway.failCreate = true;
      for (let i = 0; i < CAP + 2; i++) expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(502);
      gateway.failCreate = false;
      expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(200);
    });

    it('otro evento desde la misma IP no comparte cupo', async () => {
      const other = await createTestEvent({ maxCapacity: 100 });
      const otherTt = await createTicketType(other.id, { maxQuantity: 100 });
      try {
        const ip = freshIp();
        for (let i = 0; i < CAP; i++) await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip);
        const res = await post(createOrder, { ...body([{ ticketTypeId: otherTt.id, quantity: 1 }]), eventId: other.id }, ip);
        expect(res.status).toBe(200);
      } finally {
        await prisma.ticketType.deleteMany({ where: { eventId: other.id } }).catch(() => {});
        await prisma.ticket.deleteMany({ where: { eventId: other.id } });
        await cleanupTestEvent(other.id);
      }
    });
  });

  describe('cupo por IP: configurable y con un valor por defecto holgado', () => {
    it('el valor por defecto es 10 (wifi de recinto, CGNAT) y un valor vacío o inválido vuelve a él', () => {
      expect(MAX_PENDING_ORDERS_PER_IP).toBe(10);
      expect(parsePendingLimit(undefined)).toBe(10);
      expect(parsePendingLimit('')).toBe(10);
      expect(parsePendingLimit('abc')).toBe(10);
      expect(parsePendingLimit('0')).toBe(10);
      expect(parsePendingLimit('25')).toBe(25);
    });

    it('el cliente lo cambia desde la configuración (sin desplegar): con 5, el 6º es el que da 429', async () => {
      const prev = await getAndSetConfig('orders_max_pending_per_ip', '5');
      try {
        const ip = freshIp();
        for (let i = 0; i < 5; i++) expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(200);
        expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(429);
      } finally {
        await restoreConfig('orders_max_pending_per_ip', prev);
        await getAndSetConfig('orders_max_pending_per_ip', String(CAP));
      }
    });

    it('anular un pedido pendiente desde el admin libera su hueco del cupo', async () => {
      const ip = freshIp();
      const ids: string[] = [];
      for (let i = 0; i < CAP; i++) ids.push((await (await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).json()).orderId);
      expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(429);
      const o = await prisma.order.findUnique({ where: { id: ids[0] } });
      gateway.script(o!.paymentId!, { success: false, paymentId: o!.paymentId!, provider: 'fake', status: 'EXPIRED' });
      expect(await invalidateOrder(ids[0], 'CANCELLED')).toMatchObject({ success: true });
      expect((await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), ip)).status).toBe(200);
    });
  });

  describe('entradas: maxTicketsPerEmail', () => {
    beforeEach(async () => {
      await prisma.event.update({ where: { id: event.id }, data: { maxTicketsPerEmail: 2 } });
    });
    const buy = (email: string, qty = 1) => post(createOrder, body([{ ticketTypeId: tt.id, quantity: qty }], { buyerEmail: email }), freshIp());

    it('normaliza el email: minúsculas y sin +alias (ana+1@ y ANA+2@ son la misma persona)', async () => {
      expect(normalizeEmailForLimit('Ana+Uno@Gmail.COM')).toBe('ana@gmail.com');
      expect(normalizeEmailForLimit('ana@gmail.com')).toBe('ana@gmail.com');
      expect(normalizeEmailForLimit('a.na+x+y@dom.es')).toBe('a.na@dom.es');
      expect(normalizeEmailForLimit('+raro@dom.es')).toBe('+raro@dom.es');
    });

    it('cuenta los pedidos PAGADOS de la misma persona con otro alias', async () => {
      const first = await (await buy('ana+1@example.com', 2)).json();
      const o = await prisma.order.findUnique({ where: { id: first.orderId } });
      gateway.script(o!.paymentId!, paid(o!.paymentId!));
      await completeOrder(first.orderId);

      const res = await buy('ANA+dos@EXAMPLE.com');
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/máximo de entradas/);
      expect((await buy('otra@example.com')).status).toBe(200);
    });

    it('cuenta un PENDIENTE reciente (dentro de la ventana de retención)', async () => {
      expect((await buy('bea+1@example.com', 2)).status).toBe(200);
      expect((await buy('bea+2@example.com')).status).toBe(400);
    });

    it('NO cuenta un pendiente que ya superó la ventana de retención (abandonado, aún sin liberar por el cron)', async () => {
      const first = await (await buy('cris+1@example.com', 2)).json();
      await prisma.order.update({ where: { id: first.orderId }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60_000) } });
      expect((await buy('cris+2@example.com', 2)).status).toBe(200);
    });

    it('un pedido cancelado no cuenta', async () => {
      const first = await (await buy('dani@example.com', 2)).json();
      const { releaseExpiredOrder } = await import('@/lib/reconciliation/entradas');
      await releaseExpiredOrder(first.orderId);
      expect((await buy('dani+otra@example.com', 2)).status).toBe(200);
    });
  });

  describe('cancelUrl y reintento idempotente', () => {
    it('la sesión se crea con un cancelUrl hacia la ruta de abandono, firmado con el token del pedido', async () => {
      const res = await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }]), freshIp());
      const { orderId } = await res.json();
      const cancel = new URL(gateway.sessions.at(-1)!.cancelUrl);
      expect(cancel.pathname).toBe(`/api/orders/${orderId}/abandon`);
      expect(verifyOrderAccess(orderId, cancel.searchParams.get('t'))).toBe(true);
    });

    it('un reintento con la misma clave devuelve la URL de la sesión VIVA (antes: checkoutUrl null y el comprador sin salida)', async () => {
      const key = crypto.randomUUID();
      const first = await (await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }], { idempotencyKey: key }), freshIp())).json();
      expect(first.checkoutUrl).toContain('https://pay.example/');
      gateway.resumeUrl = 'https://pay.example/viva';
      const retry = await (await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }], { idempotencyKey: key }), freshIp())).json();
      expect(retry).toMatchObject({ success: true, orderId: first.orderId, checkoutUrl: 'https://pay.example/viva' });
      expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(1);
    });

    it('si la sesión ya no está abierta, el reintento sigue devolviendo checkoutUrl null (la confirmación lo explica)', async () => {
      const key = crypto.randomUUID();
      await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }], { idempotencyKey: key }), freshIp());
      gateway.resumeUrl = null;
      const retry = await (await post(createOrder, body([{ ticketTypeId: tt.id, quantity: 1 }], { idempotencyKey: key }), freshIp())).json();
      expect(retry.checkoutUrl).toBeNull();
    });
  });

  describe('tienda', () => {
    const shopBody = (items: object[], over: Record<string, unknown> = {}) => ({ buyerName: 'Luis', buyerEmail: 'luis-tope@example.com', shippingAddress: 'Calle 1', shippingCity: 'Madrid', shippingZip: '28001', items, ...over });
    const mkProduct = async (stock = 1000) => {
      const p = await prisma.product.create({ data: { name: 'Tope', slug: `tope-${Date.now()}-${Math.random()}`, price: 10, variants: { create: { size: 'M', color: '', stock } } } });
      productIds.push(p.id);
      return p.id;
    };
    const line = (productId: string, quantity = 1) => ({ productId, quantity, size: 'M', color: '' });
    const postShop = (b: unknown, ip: string) => post(createShopOrder, b, ip);

    it('máximos de líneas, unidades por línea y unidades por pedido (400 con mensaje) sin reservar stock', async () => {
      const a = await mkProduct();
      expect((await postShop(shopBody([line(a, 11)]), freshIp())).status).toBe(400);
      const many = await Promise.all(Array.from({ length: 21 }, () => mkProduct()));
      expect((await postShop(shopBody(many.map((id) => line(id))), freshIp())).status).toBe(400);
      const four = await Promise.all(Array.from({ length: 4 }, () => mkProduct()));
      const tooMany = await postShop(shopBody(four.map((id) => line(id, 8))), freshIp()); // 32 unidades > 30
      expect(tooMany.status).toBe(400);
      expect((await tooMany.json()).error).toMatch(/Máximo 30/);
      expect((await prisma.productVariant.findFirst({ where: { productId: a } }))!.stock).toBe(1000);
      expect((await postShop(shopBody([line(a, 10)]), freshIp())).status).toBe(200); // el tope exacto se acepta
    });

    it('cupo de pedidos sin pagar por IP: el 4º da 429 y se libera al pagar', async () => {
      const a = await mkProduct();
      const ip = freshIp();
      const ids: string[] = [];
      for (let i = 0; i < CAP; i++) {
        const res = await postShop(shopBody([line(a)]), ip);
        expect(res.status).toBe(200);
        ids.push((await res.json()).orderId);
      }
      const blocked = await postShop(shopBody([line(a)]), ip);
      expect(blocked.status).toBe(429);
      expect((await prisma.productVariant.findFirst({ where: { productId: a } }))!.stock).toBe(1000 - CAP);

      const o = await prisma.shopOrder.findUnique({ where: { id: ids[0] } });
      gateway.script(o!.paymentId!, paid(o!.paymentId!));
      await completeShopOrder(ids[0]);
      expect((await postShop(shopBody([line(a)]), ip)).status).toBe(200);
    });


    it('CARRERA REAL: 8 pedidos simultáneos desde la misma IP con tope 3 → exactamente 3 creados y 5 con 429 (el cupo está serializado por IP)', async () => {
      const a = await mkProduct();
      const ip = freshIp();
      const results = await Promise.all(Array.from({ length: 8 }, () => postShop(shopBody([line(a)]), ip)));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
      expect(await prisma.shopOrder.count({ where: { items: { some: { productId: a } } } })).toBe(CAP);
      expect((await prisma.productVariant.findFirst({ where: { productId: a } }))!.stock).toBe(1000 - CAP); // los rechazados no reservaron stock
      expect(await prisma.rateLimitBucket.count({ where: { key: { startsWith: `pending:shop:${ip}#` } } })).toBe(CAP);
    });

    it('el tope de la tienda es el suyo (shop_orders_max_pending_per_ip) y no el de entradas', async () => {
      const prevShop = await getAndSetConfig('shop_orders_max_pending_per_ip', '2');
      try {
        const a = await mkProduct();
        const ip = freshIp();
        expect((await postShop(shopBody([line(a)]), ip)).status).toBe(200);
        expect((await postShop(shopBody([line(a)]), ip)).status).toBe(200);
        expect((await postShop(shopBody([line(a)]), ip)).status).toBe(429);
      } finally {
        await restoreConfig('shop_orders_max_pending_per_ip', prevShop);
        await getAndSetConfig('shop_orders_max_pending_per_ip', String(CAP));
      }
    });

    it('anular un pedido de tienda desde el admin libera su hueco del cupo', async () => {
      const a = await mkProduct();
      const ip = freshIp();
      const ids: string[] = [];
      for (let i = 0; i < CAP; i++) ids.push((await (await postShop(shopBody([line(a)]), ip)).json()).orderId);
      expect((await postShop(shopBody([line(a)]), ip)).status).toBe(429);
      const o = await prisma.shopOrder.findUnique({ where: { id: ids[0] } });
      gateway.script(o!.paymentId!, { success: false, paymentId: o!.paymentId!, provider: 'fake', status: 'EXPIRED' });
      expect(await invalidateShopOrder(ids[0], 'CANCELLED')).toMatchObject({ success: true });
      expect((await postShop(shopBody([line(a)]), ip)).status).toBe(200);
    });

    it('cancelUrl hacia la ruta de abandono de la tienda, firmado con el token del pedido', async () => {
      const a = await mkProduct();
      const { orderId } = await (await postShop(shopBody([line(a)]), freshIp())).json();
      const cancel = new URL(gateway.sessions.at(-1)!.cancelUrl);
      expect(cancel.pathname).toBe(`/api/shop/orders/${orderId}/abandon`);
      expect(verifyShopOrderAccess(orderId, cancel.searchParams.get('t'))).toBe(true);
    });

    it('reintento con la misma clave: devuelve la URL de la sesión viva', async () => {
      const a = await mkProduct();
      const key = crypto.randomUUID();
      const first = await (await postShop(shopBody([line(a)], { idempotencyKey: key }), freshIp())).json();
      gateway.resumeUrl = 'https://pay.example/viva-tienda';
      const retry = await (await postShop(shopBody([line(a)], { idempotencyKey: key }), freshIp())).json();
      expect(retry).toMatchObject({ orderId: first.orderId, checkoutUrl: 'https://pay.example/viva-tienda' });
    });
  });

  describe('carrito de la tienda: no se borra antes de pagar', () => {
    const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

    it('el checkout NO vacía el carrito al crear el pedido (ni importa writeCart)', () => {
      const src = readSrc('app/(public)/tienda/checkout/_components/shop-checkout-client.tsx');
      expect(src).not.toMatch(/writeCart/);
      expect(src).not.toMatch(/setCart\(\[\]\)/);
    });

    it('la confirmación lo vacía solo cuando el pedido consta como pagado y el carrito es el de ese pedido', () => {
      const src = readSrc('app/(public)/tienda/confirmacion/[orderId]/_components/shop-confirmation-client.tsx');
      expect(src).toMatch(/\['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'\]\.includes\(order\.status\)/);
      expect(src).toMatch(/cartMatchesOrderItems\(readCart\(\), items\)\) writeCart\(\[\]\)/);
    });

    const cart: CartLine[] = [
      { key: 'p1|M|', productId: 'p1', name: 'A', price: 10, size: 'M', color: '', quantity: 2 },
      { key: 'p2||', productId: 'p2', name: 'B', price: 5, size: null, color: null, quantity: 1 },
    ];
    it('cartMatchesOrderItems: mismas líneas y cantidades (en cualquier orden) → true; un carrito NUEVO o vacío → false', () => {
      const items = [{ productId: 'p2', size: null, color: '', quantity: 1 }, { productId: 'p1', size: 'M', color: '', quantity: 2 }];
      expect(cartMatchesOrderItems(cart, items)).toBe(true);
      expect(cartMatchesOrderItems(cart, [{ productId: 'p1', size: 'M', color: '', quantity: 3 }, items[0]])).toBe(false);
      expect(cartMatchesOrderItems(cart, [items[1]])).toBe(false);
      expect(cartMatchesOrderItems([{ ...cart[0], productId: 'otro' }, cart[1]], items)).toBe(false);
      expect(cartMatchesOrderItems([], items)).toBe(false);
    });
  });
});
