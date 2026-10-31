import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';
import bcrypt from 'bcryptjs';

const scannerEmail = `scanner-test-${Date.now()}@test.local`;
let scannerUserId: string;

// Para simular «otra puerta»: si no es null, la sesión es de ese usuario en vez del escáner de siempre.
let actingAs: string | null = null;

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: actingAs ?? scannerUserId, role: 'TAQUILLA', email: scannerEmail },
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
    // La puerta lo necesita para que el ADMIN pueda autorizar una reentrada desde este veredicto (H-077).
    expect(json.ticketId).toBe(ticketId);
  });

  it('la «hora de entrada» del duplicado va en hora de Madrid, no en la del servidor (UTC)', async () => {
    await prisma.ticket.update({ where: { id: ticketId }, data: { entryTime: new Date('2026-07-18T21:35:00Z') } });
    const res = await scanTicket(scanRequest({ qrCode, eventId: event.id }));
    const json = await res.json();
    expect(json.result).toBe('DUPLICATE');
    expect(json.message).toContain('Hora de entrada: 23:35');
  });

  it('rechaza QR desconocido', async () => {
    const res = await scanTicket(scanRequest({ qrCode: 'QR-NO-EXISTE', eventId: event.id }));
    const json = await res.json();
    expect(json.result).toBe('INVALID');
  });

  // H-074: con la wifi del recinto degradada la respuesta se perdía (timeout de 8 s), el personal volvía a escanear y un asistente legítimo veía un
  // rojo «YA ENTRÓ». Si la MISMA puerta lo admitió hace menos de 30 s, es un reintento: ámbar y con ese texto. Cualquier otra cosa sigue siendo rojo.
  describe('reintento de una lectura cuya respuesta se perdió', () => {
    let otherScannerId: string;
    const created: string[] = [];

    async function freshTicket(label: string) {
      const code = `QR-RETRY-${label}-${Date.now()}`;
      const order = await prisma.order.create({
        data: {
          eventId: event.id, buyerName: 'Retry', buyerLastName: label, buyerEmail: 'retry@example.com', totalAmount: 10, status: 'COMPLETED',
          tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode: code, holderName: `Retry ${label}`, status: 'VALID' } },
        },
        include: { tickets: true },
      });
      created.push(order.tickets[0].id);
      return { code, ticketId: order.tickets[0].id };
    }

    beforeAll(async () => {
      const other = await prisma.user.create({
        data: { email: `scanner-other-${Date.now()}@test.local`, name: 'Otra puerta', hashedPassword: await bcrypt.hash('x', 4), role: 'TAQUILLA' },
      });
      otherScannerId = other.id;
    });

    afterAll(async () => {
      actingAs = null;
      await prisma.scanLog.deleteMany({ where: { ticketId: { in: created } } });
      await prisma.user.delete({ where: { id: otherScannerId } }).catch(() => {});
    });

    it('la misma puerta, a los pocos segundos: ámbar, «acaba de entrar» y retry: true', async () => {
      const { code } = await freshTicket('mismo');
      expect((await (await scanTicket(scanRequest({ qrCode: code, eventId: event.id }))).json()).result).toBe('VALID');
      const json = await (await scanTicket(scanRequest({ qrCode: code, eventId: event.id }))).json();
      expect(json.result).toBe('DUPLICATE');
      expect(json.color).toBe('yellow');
      expect(json.retry).toBe(true);
      expect(json.message).toMatch(/acaba de entrar/i);
    });

    it('otra puerta distinta sigue viendo el rojo: puede ser una entrada pasada a otra persona', async () => {
      const { code } = await freshTicket('otra');
      await scanTicket(scanRequest({ qrCode: code, eventId: event.id }));
      actingAs = otherScannerId;
      try {
        const json = await (await scanTicket(scanRequest({ qrCode: code, eventId: event.id }))).json();
        expect(json.result).toBe('DUPLICATE');
        expect(json.color).toBe('red');
        expect(json.retry).toBeUndefined();
      } finally {
        actingAs = null;
      }
    });

    it('la misma puerta pero pasada la ventana (31 s): rojo', async () => {
      const { code, ticketId: id } = await freshTicket('tarde');
      await scanTicket(scanRequest({ qrCode: code, eventId: event.id }));
      const old = new Date(Date.now() - 31_000);
      await prisma.ticket.update({ where: { id }, data: { entryTime: old } });
      await prisma.scanLog.updateMany({ where: { ticketId: id }, data: { createdAt: old } });
      const json = await (await scanTicket(scanRequest({ qrCode: code, eventId: event.id }))).json();
      expect(json.color).toBe('red');
      expect(json.retry).toBeUndefined();
    });
  });
});
