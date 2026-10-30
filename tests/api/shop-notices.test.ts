import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import * as brand from '@/lib/brand/brand';
import { syncProductVariants } from '@/lib/product-stock';
import { completeShopOrder } from '@/lib/reconciliation/tienda';
import { notifyShopNewOrder, sendShopShippedEmail, shopNewOrderEmailHtml, sweepShopNewOrderNotices } from '@/lib/shop/shop-notices';

const mailer = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; html: string; replyTo?: string }[], fail: false, delayMs: 0 }));

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'shop-notices-admin', role: 'ADMIN' } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/mailer', async (orig) => ({
  ...(await orig<typeof import('@/lib/mailer')>()),
  sendMail: async (p: { to: string; subject: string; html: string; replyTo?: string }) => {
    if (mailer.delayMs > 0) await new Promise((r) => setTimeout(r, mailer.delayMs));
    if (mailer.fail) return { success: false, transport: 'none' as const, error: 'smtp caído' };
    mailer.sent.push({ to: p.to, subject: p.subject, html: p.html, replyTo: p.replyTo });
    return { success: true, transport: 'smtp' as const };
  },
}));

const { PUT: putShopOrder } = await import('@/app/api/admin/shop-orders/[id]/route');

/* P1-10: el vendedor recibe un email por cada pedido nuevo pagado y el comprador otro cuando el pedido sale (con su enlace y el seguimiento). */

const SELLER = 'vendedor-p110@example.com';
const NOTICE_PREFIX = 'shop-new-order-notice:';
const SHIPPED_PREFIX = 'shop-shipped-mail:';

describe('avisos de la tienda (P1-10)', () => {
  let productId: string;
  const orderIds: string[] = [];
  let testStart: Date;

  beforeAll(async () => {
    testStart = new Date(Date.now() - 1000);
    const product = await prisma.product.create({ data: { name: '[TEST] Camiseta P110', slug: `test-p110-${Date.now()}`, price: 20, sizes: 'M', colors: 'Negro', isActive: true } });
    productId = product.id;
    await prisma.$transaction((tx) => syncProductVariants(tx, product.id, product.sizes, product.colors, [{ size: 'M', color: 'Negro', stock: 50 }]));
    await prisma.appConfig.upsert({ where: { key: 'notify_email_tienda' }, update: { value: SELLER }, create: { key: 'notify_email_tienda', value: SELLER, label: 'notify_email_tienda', group: 'tienda' } });
    // «Instalado» hace una hora: el barrido alcanza a los pedidos de este test.
    await prisma.appConfig.upsert({ where: { key: 'shop_new_order_notice_since' }, update: { value: String(Date.now() - 3600_000) }, create: { key: 'shop_new_order_notice_since', value: String(Date.now() - 3600_000), label: 'x', group: 'system' } });
  });

  afterAll(async () => {
    await prisma.processedWebhookEvent.deleteMany({
      where: { OR: [{ id: { startsWith: NOTICE_PREFIX }, processedAt: { gte: testStart } }, { id: { startsWith: SHIPPED_PREFIX }, processedAt: { gte: testStart } }, ...orderIds.map((id) => ({ id: { contains: id } }))] },
    });
    await prisma.shopOrderItem.deleteMany({ where: { productId } });
    await prisma.shopOrder.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.product.delete({ where: { id: productId } }).catch(() => {});
    await prisma.appConfig.deleteMany({ where: { key: { in: ['notify_email_tienda', 'shop_new_order_notice_since'] } } });
  });

  beforeEach(() => {
    mailer.sent = [];
    mailer.fail = false;
    mailer.delayMs = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  async function order(status: 'PENDING' | 'PAID' | 'SHIPPED', over: { name?: string; email?: string; address?: string; tracking?: string | null } = {}) {
    const o = await prisma.shopOrder.create({
      data: {
        buyerName: over.name ?? 'Luis Pérez',
        buyerEmail: over.email ?? `comprador-p110-${Math.random().toString(36).slice(2, 8)}@example.com`,
        shippingAddress: over.address ?? 'Calle Mayor 1, 2º B',
        shippingCity: 'Madrid',
        shippingZip: '28001',
        shippingPhone: '600111222',
        totalAmount: 40,
        status,
        paymentProvider: 'mock',
        trackingNumber: over.tracking ?? null,
        items: { create: [{ productId, quantity: 2, unitPrice: 20, size: 'M', color: 'Negro' }] },
      },
    });
    orderIds.push(o.id);
    return o;
  }
  const put = (id: string, body: unknown) => putShopOrder(new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const toSeller = () => mailer.sent.filter((m) => m.to === SELLER);

  describe('aviso al vendedor de un pedido nuevo', () => {
    it('al pagarse el pedido, el vendedor recibe un email con líneas, talla, color, comprador y dirección (y el comprador, su confirmación)', async () => {
      const o = await order('PENDING', { name: 'Ana Gómez' });
      expect(await completeShopOrder(o.id, undefined, { emailInline: true })).toBe('completed');
      const mails = toSeller();
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toContain(`#${o.id.slice(0, 8)}`);
      expect(mails[0].subject).toContain('40,00');
      const html = mails[0].html;
      expect(html).toContain('[TEST] Camiseta P110');
      expect(html).toContain('M · Negro');
      expect(html).toContain('Ana Gómez');
      expect(html).toContain('Calle Mayor 1, 2º B');
      expect(html).toContain('28001');
      expect(html).toContain('/admin/pedidos');
      expect(mailer.sent.some((m) => m.to === o.buyerEmail)).toBe(true); // la confirmación al comprador sigue saliendo
    });

    it('es idempotente: volver a confirmar el mismo pago o relanzar el aviso no lo repite', async () => {
      const o = await order('PENDING');
      await completeShopOrder(o.id, undefined, { emailInline: true });
      expect(await completeShopOrder(o.id, undefined, { emailInline: true })).toBe('already_completed');
      expect(await notifyShopNewOrder(o.id)).toBe('skipped');
      expect(toSeller()).toHaveLength(1);
    });

    it('un pedido sin pagar o anulado no genera aviso', async () => {
      const pending = await order('PENDING');
      expect(await notifyShopNewOrder(pending.id)).toBe('not_applicable');
      await prisma.shopOrder.update({ where: { id: pending.id }, data: { status: 'CANCELLED' } });
      expect(await notifyShopNewOrder(pending.id)).toBe('not_applicable');
      expect(toSeller()).toHaveLength(0);
    });

    it('lo que escribió el comprador va escapado en el email (nada de HTML ejecutable)', async () => {
      const html = shopNewOrderEmailHtml(
        {
          id: 'abcdefgh1234',
          buyerName: '<script>alert(1)</script>',
          buyerEmail: 'x@example.com',
          shippingAddress: '"><img src=x onerror=alert(1)>',
          shippingCity: '<b>Madrid</b>',
          shippingZip: '28001',
          shippingPhone: null,
          totalAmount: 10,
          items: [{ quantity: 1, unitPrice: 10, size: '<M>', color: null, product: { name: '<i>Camiseta</i>' } }],
        },
        { name: 'Tienda', colors: { emailAccent: '#123456' } } as never,
        'https://tienda.example.com'
      );
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<b>Madrid');
      expect(html).not.toContain('<i>Camiseta');
      expect(html).toContain('&lt;script&gt;');
    });

    it('si el correo falla, el aviso se libera y el barrido del cron lo recupera sin duplicar', async () => {
      const o = await order('PENDING');
      mailer.fail = true;
      await completeShopOrder(o.id, undefined, { emailInline: true });
      expect(await prisma.processedWebhookEvent.count({ where: { id: `${NOTICE_PREFIX}${o.id}` } })).toBe(0);
      expect(toSeller()).toHaveLength(0);

      mailer.fail = false;
      const sweep = await sweepShopNewOrderNotices({ deadline: Date.now() + 20_000, limit: 200 });
      expect(sweep.sent).toBeGreaterThanOrEqual(1);
      expect(toSeller().some((m) => m.subject.includes(`#${o.id.slice(0, 8)}`))).toBe(true);
      const after = toSeller().length;
      await sweepShopNewOrderNotices({ deadline: Date.now() + 20_000, limit: 200 });
      expect(toSeller()).toHaveLength(after); // ya consta: no se repite
    });

    it('revisión P1-10: un fallo DESPUÉS de reclamar el marcador (aquí, la marca de la tienda) lo libera: el aviso no se pierde y el barrido lo recupera', async () => {
      const o = await order('PAID');
      await prisma.processedWebhookEvent.create({ data: { id: `email:shop:${o.id}:due` } }); // lo que programa completeShopOrder: el barrido parte de aquí
      vi.spyOn(brand, 'getBrand').mockRejectedValueOnce(new Error('BD caída un instante'));
      expect(await notifyShopNewOrder(o.id)).toBe('failed');
      expect(await prisma.processedWebhookEvent.count({ where: { id: `${NOTICE_PREFIX}${o.id}` } })).toBe(0);
      const sweep = await sweepShopNewOrderNotices({ deadline: Date.now() + 20_000, limit: 200 });
      expect(sweep.sent).toBeGreaterThanOrEqual(1);
      expect(toSeller().some((m) => m.subject.includes(`#${o.id.slice(0, 8)}`))).toBe(true);
    });

    it('revisión P1-10: si el tope de tiempo vence pero el correo sí sale, el marcador se queda y no se repite el aviso', async () => {
      const o = await order('PAID');
      mailer.delayMs = 150;
      expect(await notifyShopNewOrder(o.id, { capMs: 20 })).toBe('failed'); // venció el tope
      expect(await prisma.processedWebhookEvent.count({ where: { id: `${NOTICE_PREFIX}${o.id}` } })).toBe(1);
      await new Promise((r) => setTimeout(r, 300)); // el correo llega
      expect(toSeller().filter((m) => m.subject.includes(`#${o.id.slice(0, 8)}`))).toHaveLength(1);
      mailer.delayMs = 0;
      expect(await notifyShopNewOrder(o.id)).toBe('skipped'); // y un reintento no lo duplica
      expect(toSeller().filter((m) => m.subject.includes(`#${o.id.slice(0, 8)}`))).toHaveLength(1);
    });

    it('revisión P1-10: con menos tiempo del que cabe en un envío el barrido no lo intenta (no hay topes de 1 s que venzan siempre)', async () => {
      const o = await order('PAID');
      await prisma.processedWebhookEvent.create({ data: { id: `email:shop:${o.id}:due` } });
      const sweep = await sweepShopNewOrderNotices({ deadline: Date.now() + 2_000, limit: 200 });
      expect(sweep.examined).toBe(0);
      expect(await prisma.processedWebhookEvent.count({ where: { id: `${NOTICE_PREFIX}${o.id}` } })).toBe(0);
    });

    it('el barrido no avisa de pedidos pagados antes de instalar la función', async () => {
      const o = await order('PENDING');
      await completeShopOrder(o.id, undefined, { emailInline: true });
      await prisma.processedWebhookEvent.deleteMany({ where: { id: `${NOTICE_PREFIX}${o.id}` } });
      await prisma.appConfig.update({ where: { key: 'shop_new_order_notice_since' }, data: { value: String(Date.now() + 60_000) } });
      mailer.sent = [];
      await sweepShopNewOrderNotices({ deadline: Date.now() + 20_000, limit: 200 });
      expect(toSeller().some((m) => m.subject.includes(`#${o.id.slice(0, 8)}`))).toBe(false);
      await prisma.appConfig.update({ where: { key: 'shop_new_order_notice_since' }, data: { value: String(Date.now() - 3600_000) } });
    });
  });

  describe('email de envío al comprador', () => {
    it('al pasar a «Enviado» el comprador recibe un email con el enlace a su pedido y el seguimiento', async () => {
      const o = await order('PAID', { name: 'Marta' });
      const res = await put(o.id, { status: 'SHIPPED', trackingNumber: 'CORREOS-123ABC' });
      expect(res.status).toBe(200);
      expect((await res.json()).shippedEmail).toBe('sent');
      const mails = mailer.sent.filter((m) => m.to === o.buyerEmail);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toContain('en camino');
      expect(mails[0].html).toContain('CORREOS-123ABC');
      expect(mails[0].html).toContain(`/tienda/confirmacion/${o.id}?`);
      expect(mails[0].replyTo).toBe(SELLER);
    });

    it('sin número de seguimiento sale igual, y cuando llega el número se envía otro con él (una vez por número)', async () => {
      const o = await order('PAID');
      expect((await (await put(o.id, { status: 'SHIPPED' })).json()).shippedEmail).toBe('sent');
      expect((await (await put(o.id, { trackingNumber: 'SEUR-999' })).json()).shippedEmail).toBe('sent');
      expect((await (await put(o.id, { trackingNumber: 'SEUR-999' })).json()).shippedEmail).toBeUndefined(); // el mismo número no es un cambio
      const mails = mailer.sent.filter((m) => m.to === o.buyerEmail);
      expect(mails).toHaveLength(2);
      expect(mails[0].html).toContain('Todavía no tenemos un número de seguimiento');
      expect(mails[1].html).toContain('SEUR-999');
    });

    it('un cambio de estado que no es «Enviado» no envía nada', async () => {
      const o = await order('PAID');
      const res = await put(o.id, { status: 'PROCESSING' });
      expect((await res.json()).shippedEmail).toBeUndefined();
      expect(mailer.sent.filter((m) => m.to === o.buyerEmail)).toHaveLength(0);
    });

    it('si el correo falla, el pedido queda «Enviado» igualmente, se avisa al admin y «Reenviar» lo envía', async () => {
      const o = await order('PAID');
      mailer.fail = true;
      const res = await put(o.id, { status: 'SHIPPED', trackingNumber: 'DHL-1' });
      expect(res.status).toBe(200);
      expect((await res.json()).shippedEmail).toBe('failed');
      expect((await prisma.shopOrder.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('SHIPPED');
      mailer.fail = false;
      expect((await (await put(o.id, { resendShippedEmail: true })).json()).shippedEmail).toBe('sent');
      expect(mailer.sent.filter((m) => m.to === o.buyerEmail)).toHaveLength(1);
      // y «Reenviar» vuelve a enviarlo aunque ya conste
      expect((await (await put(o.id, { resendShippedEmail: true })).json()).shippedEmail).toBe('sent');
      expect(mailer.sent.filter((m) => m.to === o.buyerEmail)).toHaveLength(2);
    });

    it('un pedido que no está «Enviado» no admite el aviso de envío, y un email inválido no se intenta', async () => {
      const paid = await order('PAID');
      expect(await sendShopShippedEmail(paid.id)).toBe('not_applicable');
      const bad = await order('SHIPPED', { email: 'no-es-un-email' });
      expect(await sendShopShippedEmail(bad.id)).toBe('no_recipient');
      expect(mailer.sent).toHaveLength(0);
    });
  });
});
