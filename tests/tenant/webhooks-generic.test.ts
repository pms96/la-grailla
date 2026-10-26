import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { setConfig } from '@/lib/config';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Webhook de cobro genérico (`/api/webhooks/[provider]`) y el de Stripe, con dos clientes en dos BDs: cada uno con su pasarela y su secreto. */

// Los emails de confirmación no son lo que se prueba aquí.
vi.mock('@/lib/mailer', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/mailer')>()), sendMail: vi.fn(async () => ({ success: true, transport: 'smtp' as const })) }));
vi.mock('@/lib/tickets', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/tickets')>()), sendTicketsEmail: vi.fn(async () => ({ success: true })) }));

const SECRET_A = 'whsec_cliente_a';
const SECRET_B = 'whsec_cliente_b';
let env: ReturnType<typeof enablePlatformEnv>;
let generic: typeof import('@/app/api/webhooks/[provider]/route');
let stripeRoute: typeof import('@/app/api/webhooks/stripe/route');

const sign = (payload: string, secret: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
};
const req = (provider: string, body: string, signature?: string) =>
  new Request(`http://localhost/api/webhooks/${provider}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) }, body });
const viaGeneric = (slot: 'a' | 'b', provider: string, body: string, signature?: string) =>
  withTenantForTest(slot, () => generic.POST(req(provider, body, signature), { params: Promise.resolve({ provider }) }));
const paid = (id: string, orderId: string) => JSON.stringify({ id, type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_status: 'paid', metadata: { orderId } } } });
const expired = (id: string, orderId: string) => JSON.stringify({ id, type: 'checkout.session.expired', data: { object: { id: 'cs_x', metadata: { orderId } } } });

async function configureStripe(slot: 'a' | 'b', secret: string) {
  await withTenantForTest(slot, async () => {
    await setConfig('stripe_secret_key', 'sk_test_fake');
    await setConfig('stripe_webhook_secret', secret);
  });
}
async function ticketOrder(slot: 'a' | 'b') {
  const db = tenantClient(slot);
  const event = await db.event.create({ data: { name: 'Fiesta', slug: `f-${slot}-${Math.random().toString(36).slice(2)}`, venue: 'Sala', city: 'Valencia', date: new Date(Date.now() + 86_400_000), maxCapacity: 100, status: 'PUBLISHED' } });
  const type = await db.ticketType.create({ data: { eventId: event.id, name: 'General', price: 10, maxQuantity: 50, soldCount: 1 } });
  return db.order.create({
    data: { eventId: event.id, buyerName: 'Ana', buyerLastName: 'Lopez', buyerEmail: 'ana@example.com', totalAmount: 10, paymentProvider: 'stripe', paymentId: 'cs_x', status: 'PENDING', tickets: { create: { eventId: event.id, ticketTypeId: type.id, qrCode: `QR-${Math.random()}`, holderName: 'Ana Lopez', status: 'PENDING' } } },
    include: { tickets: true },
  });
}
async function shopOrder(slot: 'a' | 'b') {
  const db = tenantClient(slot);
  const product = await db.product.create({ data: { name: 'Camiseta', slug: `c-${slot}-${Math.random().toString(36).slice(2)}`, price: 20, variants: { create: { size: 'M', color: '', stock: 5 } } } });
  return db.shopOrder.create({
    data: { buyerName: 'Ana', buyerEmail: 'ana@example.com', shippingAddress: 'C/ Sol 1', shippingCity: 'Valencia', shippingZip: '46001', totalAmount: 20, paymentProvider: 'stripe', paymentId: 'cs_x', status: 'PENDING', items: { create: { productId: product.id, quantity: 1, unitPrice: 20, size: 'M', color: '' } } },
  });
}

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
  generic = await import('@/app/api/webhooks/[provider]/route');
  stripeRoute = await import('@/app/api/webhooks/stripe/route');
}, 180_000);
beforeEach(async () => {
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('proveedores', () => {
  it.each(['paypal', 'mock', '..%2Fadmin', ''])('un proveedor desconocido (%j) da 404', async (p) => {
    expect((await viaGeneric('a', p, '{}')).status).toBe(404);
  });

  it('sin credenciales, dice que no está configurado (400)', async () => {
    const res = await viaGeneric('a', 'stripe', '{}', 't=1,v1=x');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Stripe no está configurado');
    expect((await viaGeneric('a', 'sumup', '{}')).status).toBe(400);
  });

  it('SumUp no tiene webhook: 404 con el motivo (se reconcilia por cron)', async () => {
    await withTenantForTest('a', async () => {
      await setConfig('sumup_api_key', 'key');
      await setConfig('sumup_merchant_code', 'M123');
    });
    const res = await viaGeneric('a', 'sumup', '{}');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no usa webhooks/);
  });
});

describe('Stripe por la ruta genérica y por la de siempre', () => {
  beforeEach(async () => {
    await configureStripe('a', SECRET_A);
    await configureStripe('b', SECRET_B);
  });

  it('un pago confirmado completa el pedido de ENTRADAS y valida sus entradas', async () => {
    const order = await ticketOrder('a');
    const body = paid('evt_g1', order.id);
    expect((await viaGeneric('a', 'stripe', body, sign(body, SECRET_A))).status).toBe(200);
    const row = await tenantClient('a').order.findUniqueOrThrow({ where: { id: order.id }, include: { tickets: true } });
    expect(row.status).toBe('COMPLETED');
    expect(row.tickets[0].status).toBe('VALID');
  });

  it('un pago confirmado completa el pedido de TIENDA', async () => {
    const order = await shopOrder('a');
    const body = paid('evt_g2', order.id);
    expect((await viaGeneric('a', 'stripe', body, sign(body, SECRET_A))).status).toBe(200);
    expect((await tenantClient('a').shopOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
  });

  it('un pago caducado libera el stock de la tienda', async () => {
    const order = await shopOrder('a');
    const before = await tenantClient('a').productVariant.findFirstOrThrow();
    const body = expired('evt_g3', order.id);
    expect((await viaGeneric('a', 'stripe', body, sign(body, SECRET_A))).status).toBe(200);
    expect((await tenantClient('a').shopOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    expect((await tenantClient('a').productVariant.findFirstOrThrow()).stock).toBe(before.stock + 1);
  });

  it('la ruta /api/webhooks/stripe de siempre hace lo mismo', async () => {
    const order = await ticketOrder('a');
    const body = paid('evt_g4', order.id);
    const res = await withTenantForTest('a', () => stripeRoute.POST(req('stripe', body, sign(body, SECRET_A))));
    expect(res.status).toBe(200);
    expect((await tenantClient('a').order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('COMPLETED');
  });

  it('un reintento del mismo evento es un duplicado y la marca queda con el id de Stripe a secas', async () => {
    const order = await ticketOrder('a');
    const body = paid('evt_g5', order.id);
    expect((await (await viaGeneric('a', 'stripe', body, sign(body, SECRET_A))).json())).toEqual({ received: true });
    expect((await (await viaGeneric('a', 'stripe', body, sign(body, SECRET_A))).json())).toEqual({ received: true, duplicate: true });
    expect(await tenantClient('a').processedWebhookEvent.findUnique({ where: { id: 'evt_g5' } })).not.toBeNull();
  });

  it('rechaza una firma inválida, un cuerpo alterado y la ausencia de firma, sin tocar el pedido', async () => {
    const order = await ticketOrder('a');
    const body = paid('evt_g6', order.id);
    expect((await viaGeneric('a', 'stripe', body, 't=1,v1=deadbeef')).status).toBe(400);
    expect((await viaGeneric('a', 'stripe', body)).status).toBe(400);
    expect((await viaGeneric('a', 'stripe', body.replace(order.id, 'otro'), sign(body, SECRET_A))).status).toBe(400);
    expect((await tenantClient('a').order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');
  });

  it('el secreto de un cliente NO sirve en otro: firmado con el de A, el cliente B lo rechaza y no toca nada', async () => {
    const orderB = await ticketOrder('b');
    const body = paid('evt_g7', orderB.id);
    expect((await viaGeneric('b', 'stripe', body, sign(body, SECRET_A))).status).toBe(400);
    expect((await tenantClient('b').order.findUniqueOrThrow({ where: { id: orderB.id } })).status).toBe('PENDING');
    // …y con el suyo, sí.
    expect((await viaGeneric('b', 'stripe', body, sign(body, SECRET_B))).status).toBe(200);
  });

  it('un evento de otro cliente (pedido que no existe aquí) no cambia nada y no falla', async () => {
    const orderA = await ticketOrder('a');
    const body = paid('evt_g8', orderA.id);
    expect((await viaGeneric('b', 'stripe', body, sign(body, SECRET_B))).status).toBe(200);
    expect((await tenantClient('a').order.findUniqueOrThrow({ where: { id: orderA.id } })).status).toBe('PENDING');
  });
});
