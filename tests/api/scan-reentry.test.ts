import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

let session: { user: { id: string; role: string } } | null = null;
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: reentry } = await import('@/app/api/scan/reentry/route');
const { GET: capacity } = await import('@/app/api/access/capacity/route');

// H-077: «dentro» era un acumulado de admitidos y quien salía a fumar recibía un rojo DUPLICATE sin salida. El ADMIN puede autorizar una reentrada:
// queda en el registro (`ScanLog` REENTRY), NO suma al «han entrado» y no cuenta como escaneo rechazado.

function req(body: unknown) {
  return new Request('http://localhost/api/scan/reentry', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.88' }, body: JSON.stringify(body) });
}

describe('POST /api/scan/reentry', () => {
  let adminId: string;
  let staffId: string;
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let other: Awaited<ReturnType<typeof createTestEvent>>;
  const tickets: Record<string, string> = {};

  async function makeTicket(label: string, over: { eventId?: string; ticketStatus?: 'USED' | 'VALID'; orderStatus?: 'COMPLETED' | 'REFUNDED' } = {}) {
    const eventId = over.eventId ?? event.id;
    const type = await createTicketType(eventId, { maxQuantity: 50 });
    const order = await prisma.order.create({
      data: {
        eventId, buyerName: 'Reentrada', buyerLastName: label, buyerEmail: 'reentry@example.com', totalAmount: 10, status: over.orderStatus ?? 'COMPLETED',
        tickets: { create: { eventId, ticketTypeId: type.id, qrCode: `QR-REENTRY-${label}-${Date.now()}`, holderName: `Reentrada ${label}`, status: over.ticketStatus ?? 'USED', entryTime: new Date() } },
      },
      include: { tickets: true },
    });
    tickets[label] = order.tickets[0].id;
    return order.tickets[0].id;
  }

  beforeAll(async () => {
    const hash = await bcrypt.hash('x', 4);
    adminId = (await prisma.user.create({ data: { email: `reentry-admin-${Date.now()}@test.local`, name: 'Admin', hashedPassword: hash, role: 'ADMIN' } })).id;
    staffId = (await prisma.user.create({ data: { email: `reentry-staff-${Date.now()}@test.local`, name: 'Taquilla', hashedPassword: hash, role: 'TAQUILLA' } })).id;
    event = await createTestEvent();
    other = await createTestEvent();
    await prisma.event.update({ where: { id: event.id }, data: { currentCount: 5 } });
  });

  afterAll(async () => {
    session = null;
    const ids = Object.values(tickets);
    await prisma.scanLog.deleteMany({ where: { OR: [{ ticketId: { in: ids } }, { eventId: { in: [event.id, other.id] } }] } });
    await cleanupTestEvent(event.id);
    await cleanupTestEvent(other.id);
    await prisma.user.deleteMany({ where: { id: { in: [adminId, staffId] } } });
  });

  it('el ADMIN autoriza la reentrada: verde, queda registrada y no suma a «han entrado»', async () => {
    const ticketId = await makeTicket('ok');
    session = { user: { id: adminId, role: 'ADMIN' } };
    const res = await reentry(req({ ticketId, eventId: event.id }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.result).toBe('REENTRY');
    expect(json.color).toBe('green');
    expect(json.message).toMatch(/reentrada/i);

    const logs = await prisma.scanLog.findMany({ where: { ticketId } });
    expect(logs).toHaveLength(1);
    expect(logs[0].result).toBe('REENTRY');
    expect(logs[0].scannerId).toBe(adminId);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status).toBe('USED');
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).currentCount).toBe(5);
  });

  it('la taquilla no puede: 403 y no se registra nada', async () => {
    const ticketId = await makeTicket('staff');
    session = { user: { id: staffId, role: 'TAQUILLA' } };
    const res = await reentry(req({ ticketId, eventId: event.id }));
    expect(res.status).toBe(403);
    expect(await prisma.scanLog.count({ where: { ticketId } })).toBe(0);
  });

  it('sin sesión: 401', async () => {
    session = null;
    expect((await reentry(req({ ticketId: 'x', eventId: event.id }))).status).toBe(401);
  });

  it('una entrada que aún no ha entrado no es una reentrada: 409', async () => {
    const ticketId = await makeTicket('valid', { ticketStatus: 'VALID' });
    session = { user: { id: adminId, role: 'ADMIN' } };
    const res = await reentry(req({ ticketId, eventId: event.id }));
    expect(res.status).toBe(409);
    expect(await prisma.scanLog.count({ where: { ticketId } })).toBe(0);
  });

  it('una entrada de otro evento: 400', async () => {
    const ticketId = await makeTicket('otro', { eventId: other.id });
    session = { user: { id: adminId, role: 'ADMIN' } };
    expect((await reentry(req({ ticketId, eventId: event.id }))).status).toBe(400);
  });

  it('un pedido reembolsado no reentra: 410', async () => {
    const ticketId = await makeTicket('reembolso', { orderStatus: 'REFUNDED' });
    session = { user: { id: adminId, role: 'ADMIN' } };
    expect((await reentry(req({ ticketId, eventId: event.id }))).status).toBe(410);
  });

  it('una entrada inexistente: 404', async () => {
    session = { user: { id: adminId, role: 'ADMIN' } };
    expect((await reentry(req({ ticketId: 'no-existe', eventId: event.id }))).status).toBe(404);
  });

  it('una reentrada no cuenta como escaneo rechazado en el porcentaje del aforo', async () => {
    session = { user: { id: adminId, role: 'ADMIN' } };
    const ticketId = await makeTicket('tasa');
    await prisma.scanLog.deleteMany({ where: { eventId: event.id } });
    await prisma.scanLog.create({ data: { ticketId, eventId: event.id, scannerId: adminId, result: 'VALID' } });
    await reentry(req({ ticketId, eventId: event.id }));
    const json = await (await capacity(new Request(`http://localhost/api/access/capacity?eventId=${event.id}`))).json();
    expect(json.entryRate5min).toBe(1);
    expect(json.rejectionRate5min).toBe(0);
  });
});
