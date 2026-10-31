import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: 'test-admin', role: 'ADMIN', email: 'admin@test.local' },
  })),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

// El email de la invitación sale por el único punto de envío (lib/order-email.ts), que construye el email con `deliverTicketsEmail`.
vi.mock('@/lib/tickets', () => ({
  deliverTicketsEmail: vi.fn(async () => ({ success: true, transport: 'none' })),
}));

const { POST: createInvitation } = await import('@/app/api/invitations/route');

function inviteRequest(body: unknown) {
  return new Request('http://localhost/api/invitations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/invitations', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    event = await createTestEvent({ maxCapacity: 10 });
  });

  afterAll(async () => {
    await prisma.invitation.deleteMany({ where: { eventId: event.id } });
    await cleanupTestEvent(event.id);
  });

  it('crea invitación con pedido COMPLETED y entradas VALID', async () => {
    const res = await createInvitation(
      inviteRequest({
        eventId: event.id,
        guestName: 'VIP Test',
        guestEmail: 'vip@example.com',
        quantity: 2,
        sendEmail: false,
      })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.invitation?.id).toBeTruthy();
    expect(json.orderId).toBeTruthy();

    const order = await prisma.order.findUnique({
      where: { id: json.orderId },
      include: { tickets: true },
    });
    expect(order?.status).toBe('COMPLETED');
    expect(order?.channel).toBe('INVITACION');
    expect(order?.tickets).toHaveLength(2);
    expect(order?.tickets.every((t) => t.status === 'VALID')).toBe(true);
  });

  it('con sendEmail envía la invitación por el único punto de envío (P0-08): queda enviada, con su intento, y la respuesta lo dice', async () => {
    const res = await createInvitation(
      inviteRequest({ eventId: event.id, guestName: 'VIP Email', guestEmail: 'vip-email@example.com', quantity: 1, sendEmail: true })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.emailResult).toMatchObject({ success: true, status: 'sent' });
    const order = await prisma.order.findUnique({ where: { id: json.orderId } });
    expect(order?.emailSentAt).toBeTruthy();
    expect(order?.emailAttempts).toBe(1);
    expect(order?.emailLastError).toBeNull();
  });

  it('rechaza si el aforo no da', async () => {
    const tiny = await createTestEvent({ maxCapacity: 1 });
    try {
      await createInvitation(
        inviteRequest({
          eventId: tiny.id,
          guestName: 'Uno',
          quantity: 1,
          sendEmail: false,
        })
      );
      const res = await createInvitation(
        inviteRequest({
          eventId: tiny.id,
          guestName: 'Dos',
          quantity: 1,
          sendEmail: false,
        })
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/aforo/i);
    } finally {
      await prisma.invitation.deleteMany({ where: { eventId: tiny.id } });
      await cleanupTestEvent(tiny.id);
    }
  });

  // H-080: se invitaba (y se enviaba el email con QR) a un evento cancelado o terminado. Un borrador SÍ admite invitaciones (lista VIP antes de anunciarlo).
  it.each(['CANCELLED', 'FINISHED'] as const)('no invita en un evento %s: 409 y ningún pedido', async (status) => {
    const closed = await createTestEvent({ status, maxCapacity: 10 });
    try {
      const res = await createInvitation(inviteRequest({ eventId: closed.id, guestName: 'Nadie', quantity: 1, sendEmail: false }));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('event_not_open');
      expect(await prisma.order.count({ where: { eventId: closed.id } })).toBe(0);
    } finally {
      await cleanupTestEvent(closed.id);
    }
  });

  it('un borrador admite invitaciones', async () => {
    const draft = await createTestEvent({ status: 'DRAFT', maxCapacity: 10 });
    try {
      const res = await createInvitation(inviteRequest({ eventId: draft.id, guestName: 'VIP', quantity: 1, sendEmail: false }));
      expect(res.status).toBe(200);
    } finally {
      await prisma.invitation.deleteMany({ where: { eventId: draft.id } });
      await cleanupTestEvent(draft.id);
    }
  });

  it('una cantidad no numérica se trata como 1 (no da NaN ni 500)', async () => {
    const res = await createInvitation(inviteRequest({ eventId: event.id, guestName: 'Cantidad rara', quantity: 'abc', sendEmail: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).invitation.quantity).toBe(1);
  });
});
