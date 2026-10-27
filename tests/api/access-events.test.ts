import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

let currentRole: string | null = 'TAQUILLA';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (currentRole ? { user: { id: 'tester', role: currentRole } } : null)),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

const { GET: listDoorEvents } = await import('@/app/api/access/events/route');

type DoorEvent = Record<string, unknown> & { id: string };

describe('GET /api/access/events (lista de eventos del escáner)', () => {
  let published: Awaited<ReturnType<typeof createTestEvent>>;
  let draft: Awaited<ReturnType<typeof createTestEvent>>;
  let finished: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    published = await createTestEvent({ maxCapacity: 300 });
    draft = await createTestEvent({ status: 'DRAFT' });
    finished = await createTestEvent({ status: 'FINISHED' });
    await createTicketType(published.id, { price: 25 });
    await prisma.event.update({ where: { id: published.id }, data: { currentCount: 7 } });
  });

  afterAll(async () => {
    for (const e of [published, draft, finished]) await cleanupTestEvent(e.id);
  });

  it('rechaza sin sesión y a un usuario normal', async () => {
    for (const role of [null, 'USER']) {
      currentRole = role;
      expect((await listDoorEvents()).status, String(role)).toBe(401);
    }
    currentRole = 'TAQUILLA';
  });

  it('TAQUILLA y ADMIN reciben solo los eventos publicados', async () => {
    for (const role of ['TAQUILLA', 'ADMIN']) {
      currentRole = role;
      const res = await listDoorEvents();
      expect(res.status).toBe(200);
      const data = (await res.json()) as DoorEvent[];
      expect(data.find((e) => e.id === published.id)).toBeDefined();
      expect(data.find((e) => e.id === draft.id)).toBeUndefined();
      expect(data.find((e) => e.id === finished.id)).toBeUndefined();
    }
    currentRole = 'TAQUILLA';
  });

  it('devuelve únicamente lo que necesita el escáner: sin tipos de entrada, precios, compradores ni campos internos', async () => {
    const data = (await (await listDoorEvents()).json()) as DoorEvent[];
    const ev = data.find((e) => e.id === published.id)!;
    expect(Object.keys(ev).sort()).toEqual(['currentCount', 'date', 'id', 'maxCapacity', 'name', 'status']);
    expect(ev.currentCount).toBe(7);
    expect(ev.maxCapacity).toBe(300);
    expect(ev.name).toBe(published.name);
  });
});
