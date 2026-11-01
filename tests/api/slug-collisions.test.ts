import { describe, it, expect, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'slug-admin', role: 'ADMIN', email: 'slug-admin@test.local' } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: createEvent } = await import('@/app/api/admin/events/route');
const { POST: createProduct } = await import('@/app/api/admin/products/route');

/* H-052: crear dos eventos (o productos) con el mismo nombre, o con un nombre sin letras, daba 500 y el admin no podía crear el evento. */

const post = (handler: (r: Request) => Promise<Response>, body: unknown) => handler(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const tag = `Slug${Date.now()}`;

describe('altas con nombre repetido o sin letras (H-052)', () => {
  const eventIds: string[] = [];
  const productIds: string[] = [];
  afterAll(async () => {
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  });

  it('dos eventos con el mismo nombre: los dos se crean, con slugs distintos', async () => {
    const a = await post(createEvent, { name: `Noche ${tag}` });
    const b = await post(createEvent, { name: `Noche ${tag}` });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [ea, eb] = [await a.json(), await b.json()];
    eventIds.push(ea.id, eb.id);
    expect(ea.slug).toBe(`noche-${tag.toLowerCase()}`);
    expect(eb.slug).toBe(`noche-${tag.toLowerCase()}-2`);
  });

  it('dos altas simultáneas con el mismo nombre no dan 500', async () => {
    const results = await Promise.all([post(createEvent, { name: `Carrera ${tag}` }), post(createEvent, { name: `Carrera ${tag}` }), post(createEvent, { name: `Carrera ${tag}` })]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const evs = await Promise.all(results.map((r) => r.json()));
    eventIds.push(...evs.map((e) => e.id));
    expect(new Set(evs.map((e) => e.slug)).size).toBe(3);
  });

  it('un evento con un nombre sin letras se crea con un slug de reserva (antes quedaba vacío)', async () => {
    const res = await post(createEvent, { name: '🍺🍺🍺' });
    expect(res.status).toBe(200);
    const ev = await res.json();
    eventIds.push(ev.id);
    expect(ev.slug).toMatch(/^evento(-\d+|-[a-z0-9]{6})?$/);
  });

  it('dos productos con el mismo nombre: los dos se crean, con slugs distintos', async () => {
    const a = await post(createProduct, { name: `Gorra ${tag}`, price: 10 });
    const b = await post(createProduct, { name: `Gorra ${tag}`, price: 10 });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [pa, pb] = [await a.json(), await b.json()];
    productIds.push(pa.id, pb.id);
    expect(pa.slug).not.toBe(pb.slug);
    expect(pb.slug).toBe(`${pa.slug}-2`);
  });
});

describe('handleApiError y los P2002 sueltos', () => {
  it('un P2002 que ninguna ruta atendió es un 409 con texto para la persona, no un 500', async () => {
    const { handleApiError } = await import('@/lib/api-error');
    const { Prisma } = await import('@prisma/client');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = handleApiError(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'x', meta: { target: ['email'] } }), 'test');
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('already_exists');
    expect(data.error).toMatch(/ya existe/i);
  });
});
