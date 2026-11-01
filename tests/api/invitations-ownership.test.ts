import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { purgeAuditLog } from '../helpers/audit';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

type TestSession = { user: { id: string; role: string; email: string; modules: string[] | null } } | null;
let session: TestSession = null;
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/mailer', async (orig) => ({ ...(await orig<typeof import('@/lib/mailer')>()), sendMail: async () => ({ success: true, transport: 'smtp' as const }) }));

const { GET: listInvitations, POST: createInvitation, DELETE: deleteInvitation } = await import('@/app/api/invitations/route');
const { GET: listGuestLists, POST: createGuestList, DELETE: deleteGuestList } = await import('@/app/api/guest-lists/route');

/* H-060: la taquilla (RRPP) podía borrar cualquier invitación o lista de invitados (sin mirar de quién era), anular entradas YA USADAS al borrar una
 * invitación, y leer el email de todos los invitados. Ahora cada quien gestiona lo suyo; el ADMIN gestiona todo; una invitación con entradas ya usadas no
 * se borra (se conserva el rastro de quién entró) y el borrado queda en la auditoría. */

const user = (id: string, role: 'ADMIN' | 'TAQUILLA'): TestSession => ({ user: { id, role, email: `${id}@test.local`, modules: null } });
const RRPP_A = user('rrpp-a', 'TAQUILLA');
const RRPP_B = user('rrpp-b', 'TAQUILLA');
const ADMIN = user('admin-x', 'ADMIN');

const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('invitaciones y listas: cada quien gestiona lo suyo (H-060)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;

  const invite = async (as: TestSession, extra: Record<string, unknown> = {}) => {
    session = as;
    const res = await createInvitation(req('POST', '/api/invitations', { eventId: event.id, guestName: 'VIP', guestEmail: `vip-${Math.random().toString(36).slice(2, 8)}@example.com`, quantity: 1, ...extra }));
    expect(res.status).toBe(200);
    return (await res.json()) as { invitation: { id: string; guestEmail: string }; orderId: string };
  };
  const del = async (as: TestSession, id: string) => {
    session = as;
    return deleteInvitation(req('DELETE', `/api/invitations?id=${id}`));
  };

  beforeAll(async () => {
    event = await createTestEvent({ maxCapacity: 50 });
  });
  afterAll(async () => {
    await purgeAuditLog({ action: { in: ['invitation.delete', 'invitation.list_delete'] }, actorEmail: { endsWith: '@test.local' } });
    await prisma.invitation.deleteMany({ where: { eventId: event.id } });
    await prisma.guestList.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
  });
  beforeEach(() => {
    session = null;
  });

  it('una taquilla no borra la invitación de otra: 403 y no cambia nada', async () => {
    const inv = await invite(RRPP_A);
    const res = await del(RRPP_B, inv.invitation.id);
    expect(res.status).toBe(403);
    expect(await prisma.invitation.count({ where: { id: inv.invitation.id } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: inv.orderId } })).status).toBe('COMPLETED');
  });

  it('su autora la borra: anula pedido y entradas y deja constancia en la auditoría', async () => {
    const inv = await invite(RRPP_A);
    const res = await del(RRPP_A, inv.invitation.id);
    expect(res.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: inv.orderId } })).status).toBe('CANCELLED');
    expect(await prisma.ticket.count({ where: { orderId: inv.orderId, status: 'VALID' } })).toBe(0);
    const audit = await prisma.adminAuditLog.findFirst({ where: { action: 'invitation.delete', targetId: inv.invitation.id } });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe('rrpp-a');
  });

  it('un ADMIN borra la de cualquiera', async () => {
    const inv = await invite(RRPP_A);
    expect((await del(ADMIN, inv.invitation.id)).status).toBe(200);
    expect(await prisma.invitation.count({ where: { id: inv.invitation.id } })).toBe(0);
  });

  it('con una entrada ya USADA no se borra, ni siquiera un ADMIN: 409 y el aforo no se toca', async () => {
    const inv = await invite(ADMIN, { quantity: 2 });
    const [first] = await prisma.ticket.findMany({ where: { orderId: inv.orderId } });
    await prisma.ticket.update({ where: { id: first.id }, data: { status: 'USED', entryTime: new Date() } });
    await prisma.event.update({ where: { id: event.id }, data: { currentCount: 1 } });
    for (const who of [ADMIN]) {
      const res = await del(who, inv.invitation.id);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('invitation_has_entries');
    }
    expect(await prisma.invitation.count({ where: { id: inv.invitation.id } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: inv.orderId } })).status).toBe('COMPLETED');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('USED');
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).currentCount).toBe(1);
    await prisma.event.update({ where: { id: event.id }, data: { currentCount: 0 } });
  });

  it('GET: la taquilla ve solo sus invitaciones; el ADMIN, todas', async () => {
    const a = await invite(RRPP_A, { guestEmail: 'solo-de-a@example.com' });
    const b = await invite(RRPP_B, { guestEmail: 'solo-de-b@example.com' });
    session = RRPP_B;
    const asB = (await (await listInvitations(req('GET', `/api/invitations?eventId=${event.id}`))).json()) as { id: string }[];
    expect(asB.map((i) => i.id)).toContain(b.invitation.id);
    expect(asB.map((i) => i.id)).not.toContain(a.invitation.id);
    expect(JSON.stringify(asB)).not.toContain('solo-de-a@example.com');
    session = ADMIN;
    const asAdmin = (await (await listInvitations(req('GET', `/api/invitations?eventId=${event.id}`))).json()) as { id: string }[];
    expect(asAdmin.map((i) => i.id)).toEqual(expect.arrayContaining([a.invitation.id, b.invitation.id]));
  });

  it('una taquilla no añade invitados a la lista de otra', async () => {
    session = RRPP_A;
    const list = (await (await createGuestList(req('POST', '/api/guest-lists', { eventId: event.id, name: 'Lista de A' }))).json()) as { id: string };
    session = RRPP_B;
    const res = await createInvitation(req('POST', '/api/invitations', { eventId: event.id, listId: list.id, guestName: 'Intruso', quantity: 1 }));
    expect(res.status).toBe(403);
    expect(await prisma.invitation.count({ where: { listId: list.id } })).toBe(0);
  });

  describe('listas de invitados', () => {
    const makeList = async (as: TestSession, name: string) => {
      session = as;
      const res = await createGuestList(req('POST', '/api/guest-lists', { eventId: event.id, name }));
      expect(res.status).toBe(200);
      return (await res.json()) as { id: string };
    };
    const delList = (as: TestSession, id: string) => {
      session = as;
      return deleteGuestList(req('DELETE', `/api/guest-lists?id=${id}`));
    };

    it('una taquilla no borra la lista de otra (403); su dueña sí; un ADMIN cualquiera; queda auditado', async () => {
      const list = await makeList(RRPP_A, 'Mi lista');
      expect((await delList(RRPP_B, list.id)).status).toBe(403);
      expect(await prisma.guestList.count({ where: { id: list.id } })).toBe(1);
      expect((await delList(RRPP_A, list.id)).status).toBe(200);
      expect(await prisma.adminAuditLog.count({ where: { action: 'invitation.list_delete', targetId: list.id } })).toBe(1);

      const other = await makeList(RRPP_A, 'Otra lista');
      expect((await delList(ADMIN, other.id)).status).toBe(200);
    });

    it('GET: la taquilla ve solo sus listas; el ADMIN todas', async () => {
      const mine = await makeList(RRPP_A, 'Lista A');
      const theirs = await makeList(RRPP_B, 'Lista B');
      await invite(RRPP_A, { listId: mine.id, guestEmail: 'lista-a@example.com' });
      session = RRPP_A;
      const asA = (await (await listGuestLists(req('GET', `/api/guest-lists?eventId=${event.id}`))).json()) as { id: string; invitations: unknown[] }[];
      expect(asA.map((l) => l.id)).toContain(mine.id);
      expect(asA.map((l) => l.id)).not.toContain(theirs.id);
      session = ADMIN;
      const asAdmin = (await (await listGuestLists(req('GET', `/api/guest-lists?eventId=${event.id}`))).json()) as { id: string }[];
      expect(asAdmin.map((l) => l.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    });
  });
});
