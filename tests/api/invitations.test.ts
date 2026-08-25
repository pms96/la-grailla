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

vi.mock('@/lib/tickets', () => ({
  sendTicketsEmail: vi.fn(async () => ({ success: true, transport: 'none' })),
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
});
