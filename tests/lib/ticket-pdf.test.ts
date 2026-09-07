import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  buildTicketsPdf,
  buildTicketsPdfForRoll,
  TAQUILLA_TICKET_WIDTH_PT,
  TAQUILLA_TICKET_HEIGHT_PT,
} from '@/lib/ticket-pdf';

function sampleOrder() {
  return {
    id: 'order-test',
    eventId: 'ev',
    buyerName: 'Ana',
    buyerLastName: 'García',
    buyerEmail: 'ana@example.com',
    totalAmount: 10,
    commission: 0,
    paymentMethod: 'CARD' as const,
    paymentProvider: null,
    paymentId: null,
    status: 'COMPLETED' as const,
    idempotencyKey: null,
    soldById: null,
    channel: 'ONLINE' as const,
    pdfUrl: null,
    emailSentAt: null,
    emailLastError: null,
    emailAttempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    event: {
      id: 'ev',
      name: 'Feria Sabado Noche',
      slug: 'noche',
      description: null,
      venue: 'Caseta',
      city: 'Encinas Reales',
      address: null,
      imageUrl: null,
      artists: null,
      date: new Date('2026-09-25T22:00:00Z'),
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
      status: 'PUBLISHED' as const,
      alertAt80: true,
      alertAt95: true,
      alertThresholds: '80,95,100',
      alertsSent: '',
      latitude: null,
      longitude: null,
      temporadaId: null,
      archivado: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    tickets: [
      {
        id: 't1',
        orderId: 'order-test',
        eventId: 'ev',
        ticketTypeId: null,
        qrCode: 'LG-bc4e829b-test',
        holderName: 'Ana García',
        status: 'VALID' as const,
        entryTime: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ticketType: {
          id: 'tt1',
          eventId: 'ev',
          name: 'a',
          description: null,
          price: 10,
          phase: 1,
          phaseName: null,
          maxQuantity: 10,
          soldCount: 1,
          isActive: true,
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ],
  };
}

describe('buildTicketsPdf', () => {
  it('genera un PDF con cabecera %PDF', async () => {
    const bytes = await buildTicketsPdf(sampleOrder());

    const header = Buffer.from(bytes.slice(0, 4)).toString('utf8');
    expect(header).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(500);
  });
});

describe('buildTicketsPdfForRoll', () => {
  it('genera un PDF apaisado de 105x70mm por cada entrada', async () => {
    const order = sampleOrder();
    order.tickets.push({
      ...order.tickets[0],
      id: 't2',
      qrCode: 'LG-second-ticket',
      holderName: 'Luis Pérez',
    });
    const bytes = await buildTicketsPdfForRoll(order);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeCloseTo(TAQUILLA_TICKET_WIDTH_PT, 1);
    expect(height).toBeCloseTo(TAQUILLA_TICKET_HEIGHT_PT, 1);
    expect(width).toBeGreaterThan(height);
  });
});
