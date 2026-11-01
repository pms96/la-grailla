import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { purgeAuditLog } from '../helpers/audit';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'admin-season-test', role: 'ADMIN', email: 'admin-season@test.local' } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: createEvent } = await import('@/app/api/admin/events/route');
const { PUT: putEvent, PATCH: patchEvent } = await import('@/app/api/admin/events/[id]/route');
const { POST: createProduct } = await import('@/app/api/admin/products/route');
const { PATCH: patchProduct } = await import('@/app/api/admin/products/[id]/route');
const { PUT: putSponsor } = await import('@/app/api/admin/sponsors/[id]/route');
const { PUT: putShopOrder } = await import('@/app/api/admin/shop-orders/[id]/route');

/* H-019: P1-16 cierra una temporada para proteger los libros ya presentados, pero eventos, productos, patrocinios y pedidos de tienda se pueden enlazar a una
 * temporada: moverlos a o desde una CERRADA cambiaba su margen sin 423 y sin rastro. Ahora mover a/desde una temporada cerrada da 423 y mover entre abiertas
 * queda en la auditoría (`temporada.reassign`). Dejar el enlace como está no cuenta como mover. */

const req = (method: string, body: unknown) => new Request('http://localhost/api', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const idp = (id: string) => ({ params: Promise.resolve({ id }) });

describe('reasignar a otra temporada (H-019)', () => {
  let open1: { id: string };
  let open2: { id: string };
  let closed: { id: string };
  const events: string[] = [];
  const products: string[] = [];
  const sponsors: string[] = [];
  const orders: string[] = [];

  beforeAll(async () => {
    const mk = (nombre: string, extra: object = {}) => prisma.temporada.create({ data: { nombre: `[TEST] ${nombre}`, anio: 2097, ...extra } });
    open1 = await mk('Abierta 1');
    open2 = await mk('Abierta 2');
    closed = await mk('Cerrada', { status: 'CERRADA', closedAt: new Date() });
  });
  afterAll(async () => {
    await purgeAuditLog({ action: 'temporada.reassign', actorEmail: 'admin-season@test.local' });
    await prisma.shopOrder.deleteMany({ where: { id: { in: orders } } });
    await prisma.sponsorRequest.deleteMany({ where: { id: { in: sponsors } } });
    await prisma.product.deleteMany({ where: { id: { in: products } } });
    for (const id of events) await cleanupTestEvent(id);
    await prisma.temporada.deleteMany({ where: { id: { in: [open1.id, open2.id, closed.id] } } });
  });

  const newEvent = async (temporadaId: string | null) => {
    const e = await createTestEvent();
    events.push(e.id);
    if (temporadaId) await prisma.event.update({ where: { id: e.id }, data: { temporadaId } });
    return e;
  };
  const newProduct = async (temporadaId: string | null) => {
    const p = await prisma.product.create({ data: { name: `[TEST] Prod ${Math.random()}`, slug: `test-prod-${Math.random().toString(36).slice(2)}`, description: '', price: 5, category: 'x', temporadaId } });
    products.push(p.id);
    return p;
  };
  const newSponsor = async (temporadaId: string | null) => {
    const s = await prisma.sponsorRequest.create({ data: { companyName: '[TEST] Sponsor', contactName: 'X', temporadaId } });
    sponsors.push(s.id);
    return s;
  };
  const newOrder = async (temporadaId: string | null) => {
    const o = await prisma.shopOrder.create({ data: { buyerName: 'X', buyerEmail: 'x@example.com', shippingAddress: 'a', shippingCity: 'b', shippingZip: '1', totalAmount: 5, status: 'PAID', temporadaId } });
    orders.push(o.id);
    return o;
  };
  const auditCount = (targetId: string) => prisma.adminAuditLog.count({ where: { action: 'temporada.reassign', targetId } });

  // Cada escenario: crear la entidad enlazada a `from` y pedir moverla a `to` por su endpoint.
  const KINDS = [
    { name: 'evento (PATCH)', make: newEvent, move: (id: string, to: string | null) => patchEvent(req('PATCH', { temporadaId: to }), idp(id)), read: async (id: string) => (await prisma.event.findUniqueOrThrow({ where: { id } })).temporadaId },
    { name: 'evento (PUT)', make: newEvent, move: (id: string, to: string | null) => putEvent(req('PUT', { temporadaId: to }), idp(id)), read: async (id: string) => (await prisma.event.findUniqueOrThrow({ where: { id } })).temporadaId },
    { name: 'producto (PATCH)', make: newProduct, move: (id: string, to: string | null) => patchProduct(req('PATCH', { temporadaId: to }), idp(id)), read: async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).temporadaId },
    { name: 'patrocinio (PUT)', make: newSponsor, move: (id: string, to: string | null) => putSponsor(req('PUT', { temporadaId: to }), idp(id)), read: async (id: string) => (await prisma.sponsorRequest.findUniqueOrThrow({ where: { id } })).temporadaId },
    { name: 'pedido de tienda (PUT)', make: newOrder, move: (id: string, to: string | null) => putShopOrder(req('PUT', { temporadaId: to }), idp(id)), read: async (id: string) => (await prisma.shopOrder.findUniqueOrThrow({ where: { id } })).temporadaId },
  ];

  describe.each(KINDS)('$name', ({ make, move, read }) => {
    it('hacia una temporada CERRADA: 423 y no cambia nada', async () => {
      const row = await make(open1.id);
      const res = await move(row.id, closed.id);
      expect(res.status).toBe(423);
      expect((await res.json()).code).toBe('temporada_cerrada');
      expect(await read(row.id)).toBe(open1.id);
      expect(await auditCount(row.id)).toBe(0);
    });

    it('DESDE una temporada cerrada (a otra o a ninguna): 423 y no cambia nada', async () => {
      const row = await make(closed.id);
      for (const to of [open1.id, null]) {
        const res = await move(row.id, to);
        expect(res.status, String(to)).toBe(423);
      }
      expect(await read(row.id)).toBe(closed.id);
    });

    it('entre temporadas abiertas: se mueve y queda en la auditoría con el origen y el destino', async () => {
      const row = await make(open1.id);
      const res = await move(row.id, open2.id);
      expect(res.status).toBe(200);
      expect(await read(row.id)).toBe(open2.id);
      const audit = await prisma.adminAuditLog.findFirst({ where: { action: 'temporada.reassign', targetId: row.id } });
      expect(audit?.actorId).toBe('admin-season-test');
      expect(audit?.meta).toMatchObject({ from: open1.id, to: open2.id });
    });

    it('dejar el enlace como está (también en una cerrada) no es mover: ni 423 ni auditoría', async () => {
      const row = await make(closed.id);
      const res = await move(row.id, closed.id);
      expect(res.status).toBe(200);
      expect(await read(row.id)).toBe(closed.id);
      expect(await auditCount(row.id)).toBe(0);
    });

    it('una temporada que no existe: 404 y no cambia nada', async () => {
      const row = await make(open1.id);
      const res = await move(row.id, 'no-existe-xxxx');
      expect(res.status).toBe(404);
      expect(await read(row.id)).toBe(open1.id);
    });
  });

  it('crear un evento o un producto ya enlazado a una temporada cerrada: 423 y no se crea', async () => {
    const before = { events: await prisma.event.count(), products: await prisma.product.count() };
    const ev = await createEvent(req('POST', { name: '[TEST] Nuevo', venue: 'Sala', city: 'Ciudad', date: new Date(Date.now() + 864e5).toISOString(), temporadaId: closed.id }));
    expect(ev.status).toBe(423);
    const pr = await createProduct(req('POST', { name: '[TEST] Nuevo prod', price: 3, category: 'x', temporadaId: closed.id }));
    expect(pr.status).toBe(423);
    expect(await prisma.event.count()).toBe(before.events);
    expect(await prisma.product.count()).toBe(before.products);
  });
});
