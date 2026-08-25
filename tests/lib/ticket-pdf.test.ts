import { describe, it, expect } from 'vitest';
import { buildTicketsPdf } from '@/lib/ticket-pdf';

describe('buildTicketsPdf', () => {
  it('genera un PDF con cabecera %PDF', async () => {
    const bytes = await buildTicketsPdf({
      id: 'order-test',
      eventId: 'ev',
      buyerName: 'Ana',
      buyerLastName: 'García',
      buyerEmail: 'ana@example.com',
      totalAmount: 10,
      commission: 0,
      paymentMethod: 'CARD',
      paymentProvider: null,
      paymentId: null,
      status: 'COMPLETED',
      idempotencyKey: null,
      soldById: null,
      channel: 'ONLINE',
      pdfUrl: null,
      emailSentAt: null,
      emailLastError: null,
      emailAttempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      event: {
        id: 'ev',
        name: 'Noche Good Vibes',
        slug: 'noche',
        description: null,
        venue: 'Caseta',
        city: 'Madrid',
        address: null,
        imageUrl: null,
        artists: null,
        date: new Date('2026-09-01T22:00:00Z'),
        doorsOpen: '22:00',
        endTime: null,
        minAge: 18,
        conditions: null,
        maxCapacity: 100,
        currentCount: 0,
        maxTicketsPerEmail: null,
        waitingRoomEnabled: false,
        waitingRoomConcurrentSlots: null,
        waitingRoomPurchaseWindowSeconds: null,
        waitingRoomMessage: null,
        status: 'PUBLISHED',
        alertAt80: true,
        alertAt95: true,
        alertThresholds: '80,95,100',
        alertsSent: '',
        latitude: null,
        longitude: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      tickets: [
        {
          id: 't1',
          orderId: 'order-test',
          eventId: 'ev',
          ticketTypeId: null,
          qrCode: 'LG-TEST-QR-001',
          holderName: 'Ana García',
          status: 'VALID',
          entryTime: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ticketType: null,
        },
      ],
    });

    const header = Buffer.from(bytes.slice(0, 4)).toString('utf8');
    expect(header).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(500);
  });
});
