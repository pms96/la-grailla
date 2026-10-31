import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../helpers/fixtures';

let sessionRole: string | null = 'TAQUILLA';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () =>
    sessionRole ? { user: { id: 'staff-test', role: sessionRole, email: 'staff@test.local' } } : null
  ),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

const { GET: printTickets } = await import('@/app/api/taquilla/print/[orderId]/route');

describe('GET /api/taquilla/print/[orderId]', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let orderId: string;

  beforeAll(async () => {
    event = await createTestEvent();
    const ticketType = await createTicketType(event.id, { maxQuantity: 10 });
    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Print',
        buyerLastName: 'Test',
        buyerEmail: 'print-test@example.com',
        totalAmount: 30,
        status: 'COMPLETED',
        channel: 'TAQUILLA',
        tickets: {
          create: [1, 2, 3].map((n) => ({
            eventId: event.id,
            ticketTypeId: ticketType.id,
            qrCode: `QR-PRINT-${Date.now()}-${n}`,
            holderName: `Titular ${n}`,
            status: 'VALID',
          })),
        },
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await cleanupTestEvent(event.id);
  });

  it('devuelve un PDF apaisado 105x70mm con una página por entrada del pedido', async () => {
    sessionRole = 'TAQUILLA';
    const res = await printTickets(new Request('http://localhost'), { params: Promise.resolve({ orderId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');

    const buffer = Buffer.from(await res.arrayBuffer());
    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getPageCount()).toBe(3);
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeCloseTo(105 * (72 / 25.4), 1);
    expect(height).toBeCloseTo(70 * (72 / 25.4), 1);
    expect(width).toBeGreaterThan(height);
  });

  it('permite también al rol ADMIN', async () => {
    sessionRole = 'ADMIN';
    const res = await printTickets(new Request('http://localhost'), { params: Promise.resolve({ orderId }) });
    expect(res.status).toBe(200);
  });

  it('rechaza sin sesión', async () => {
    sessionRole = null;
    const res = await printTickets(new Request('http://localhost'), { params: Promise.resolve({ orderId }) });
    expect(res.status).toBe(401);
    sessionRole = 'TAQUILLA';
  });

  it('rechaza un rol USER', async () => {
    sessionRole = 'USER';
    const res = await printTickets(new Request('http://localhost'), { params: Promise.resolve({ orderId }) });
    expect(res.status).toBe(401);
    sessionRole = 'TAQUILLA';
  });

  // H-081: se imprimía el QR de un pedido reembolsado o de un evento cancelado (el escáner lo rechaza): ahora se explica con un 410, igual que el PDF del comprador.
  it('no imprime un pedido reembolsado ni anulado: 410', async () => {
    sessionRole = 'TAQUILLA';
    for (const status of ['REFUNDED', 'CANCELLED', 'PENDING'] as const) {
      await prisma.order.update({ where: { id: orderId }, data: { status } });
      const res = await printTickets(new Request('http://localhost'), { params: Promise.resolve({ orderId }) });
      expect(res.status, status).toBe(410);
      expect((await res.json()).error).toBeTruthy();
    }
    await prisma.order.update({ where: { id: orderId }, data: { status: 'COMPLETED' } });
  });

  it('no imprime las entradas de un evento cancelado: 410', async () => {
    sessionRole = 'TAQUILLA';
    await prisma.event.update({ where: { id: event.id }, data: { status: 'CANCELLED' } });
    const res = await printTickets(new Request('http://localhost'), { params: Promise.resolve({ orderId }) });
    expect(res.status).toBe(410);
    await prisma.event.update({ where: { id: event.id }, data: { status: 'PUBLISHED' } });
  });

  it('devuelve 404 para un pedido inexistente', async () => {
    sessionRole = 'TAQUILLA';
    const res = await printTickets(new Request('http://localhost'), { params: Promise.resolve({ orderId: 'no-existe' }) });
    expect(res.status).toBe(404);
  });
});
