import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import bcrypt from 'bcryptjs';

const scannerEmail = `scanner-test-${Date.now()}@test.local`;
let scannerUserId: string;

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: scannerUserId, role: 'TAQUILLA', email: scannerEmail },
  })),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

const { POST: scanTicket } = await import('@/app/api/scan/route');

function scanRequest(body: unknown) {
  return new Request('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/scan', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let ticketType: Awaited<ReturnType<typeof createTicketType>>;
  let qrCode: string;
  let ticketId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: scannerEmail,
        name: 'Scanner Test',
        hashedPassword: await bcrypt.hash('test-pass', 4),
        role: 'TAQUILLA',
      },
    });
    scannerUserId = user.id;

    event = await createTestEvent();
    ticketType = await createTicketType(event.id);
    qrCode = `QR-SCAN-${Date.now()}`;
    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Scan',
        buyerLastName: 'Test',
        buyerEmail: 'scan@example.com',
        totalAmount: 10,
        status: 'COMPLETED',
        tickets: {
          create: {
            eventId: event.id,
            ticketTypeId: ticketType.id,
            qrCode,
            holderName: 'Scan Test',
            status: 'VALID',
          },
        },
      },
      include: { tickets: true },
    });
    ticketId = order.tickets[0].id;
  });

  afterAll(async () => {
    await prisma.scanLog.deleteMany({ where: { ticketId } });
    await cleanupTestEvent(event.id);
    if (scannerUserId) {
      await prisma.user.delete({ where: { id: scannerUserId } }).catch(() => {});
    }
  });

  it('marca VALID como USED en el primer escaneo', async () => {
    const res = await scanTicket(scanRequest({ qrCode, eventId: event.id }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.result).toBe('VALID');

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    expect(ticket?.status).toBe('USED');
    expect(ticket?.entryTime).toBeTruthy();
  });

  it('devuelve DUPLICATE en el segundo escaneo', async () => {
    const res = await scanTicket(scanRequest({ qrCode, eventId: event.id }));
    const json = await res.json();
    expect(json.result).toBe('DUPLICATE');
  });

  it('rechaza QR desconocido', async () => {
    const res = await scanTicket(scanRequest({ qrCode: 'QR-NO-EXISTE', eventId: event.id }));
    const json = await res.json();
    expect(json.result).toBe('INVALID');
  });
});
