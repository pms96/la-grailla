// AUDIT: DATA-04 — Product, ShopOrder y SponsorRequest no tenían vínculo con
// Temporada, a diferencia de Event (Event.temporadaId, ver tests/api/events.test.ts).
// Sin esto no había forma de sacar informes de tienda/patrocinios separados por
// edición, solo de entradas. Se añade temporadaId opcional a los tres modelos,
// mismo patrón que Event: sin backfill, se enlaza manualmente desde el admin.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-data04-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { PATCH: patchProduct } = await import('@/app/api/admin/products/[id]/route');
const { PUT: putShopOrder } = await import('@/app/api/admin/shop-orders/[id]/route');
const { PUT: putSponsor } = await import('@/app/api/admin/sponsors/[id]/route');

function patchRequest(body: unknown) {
  return new Request('http://localhost', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function putRequest(body: unknown) {
  return new Request('http://localhost', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('DATA-04 — vínculo opcional con Temporada en Product/ShopOrder/SponsorRequest', () => {
  let temporada: Awaited<ReturnType<typeof prisma.temporada.create>>;
  let product: Awaited<ReturnType<typeof prisma.product.create>>;
  let shopOrder: Awaited<ReturnType<typeof prisma.shopOrder.create>>;
  let sponsorRequest: Awaited<ReturnType<typeof prisma.sponsorRequest.create>>;

  beforeAll(async () => {
    temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada DATA-04', anio: 2099 } });
    product = await prisma.product.create({
      data: { name: '[TEST] Producto DATA-04', slug: `test-data04-${Date.now()}`, price: 10, isActive: true },
    });
    shopOrder = await prisma.shopOrder.create({
      data: {
        buyerName: '[TEST] DATA-04', buyerEmail: 'data04-shop@example.com',
        shippingAddress: 'Calle Test 1', shippingCity: 'Madrid', shippingZip: '28001',
        totalAmount: 15, status: 'PAID',
      },
    });
    sponsorRequest = await prisma.sponsorRequest.create({
      data: {
        companyName: '[TEST] DATA-04', contactName: 'Test', email: 'data04-sponsor@example.com',
        sponsorType: 'Stand',
      },
    });
  });

  afterAll(async () => {
    await prisma.product.delete({ where: { id: product.id } }).catch(() => {});
    await prisma.shopOrder.delete({ where: { id: shopOrder.id } }).catch(() => {});
    await prisma.sponsorRequest.delete({ where: { id: sponsorRequest.id } }).catch(() => {});
    await prisma.temporada.delete({ where: { id: temporada.id } }).catch(() => {});
  });

  it('los tres empiezan sin temporada asignada (regresión: no rompe lo existente)', () => {
    expect(product.temporadaId).toBeNull();
    expect(shopOrder.temporadaId).toBeNull();
    expect(sponsorRequest.temporadaId).toBeNull();
  });

  it('Product: PATCH enlaza y desenlaza la temporada', async () => {
    const linked = await patchProduct(patchRequest({ temporadaId: temporada.id }), { params: { id: product.id } });
    expect(linked.status).toBe(200);
    expect((await linked.json()).temporadaId).toBe(temporada.id);

    const unlinked = await patchProduct(patchRequest({ temporadaId: null }), { params: { id: product.id } });
    expect(unlinked.status).toBe(200);
    expect((await unlinked.json()).temporadaId).toBeNull();
  });

  it('ShopOrder: PUT enlaza y desenlaza la temporada', async () => {
    const linked = await putShopOrder(putRequest({ temporadaId: temporada.id }), { params: { id: shopOrder.id } });
    expect(linked.status).toBe(200);
    expect((await linked.json()).temporadaId).toBe(temporada.id);

    const unlinked = await putShopOrder(putRequest({ temporadaId: null }), { params: { id: shopOrder.id } });
    expect(unlinked.status).toBe(200);
    expect((await unlinked.json()).temporadaId).toBeNull();
  });

  it('ShopOrder: PUT sin temporadaId en el body no toca el vínculo existente', async () => {
    await putShopOrder(putRequest({ temporadaId: temporada.id }), { params: { id: shopOrder.id } });
    const res = await putShopOrder(putRequest({ trackingNumber: 'ABC123' }), { params: { id: shopOrder.id } });
    expect(res.status).toBe(200);
    expect((await res.json()).temporadaId).toBe(temporada.id);
  });

  it('SponsorRequest: PUT enlaza y desenlaza la temporada', async () => {
    const linked = await putSponsor(putRequest({ temporadaId: temporada.id }), { params: { id: sponsorRequest.id } });
    expect(linked.status).toBe(200);
    expect((await linked.json()).temporadaId).toBe(temporada.id);

    const unlinked = await putSponsor(putRequest({ temporadaId: null }), { params: { id: sponsorRequest.id } });
    expect(unlinked.status).toBe(200);
    expect((await unlinked.json()).temporadaId).toBeNull();
  });
});
