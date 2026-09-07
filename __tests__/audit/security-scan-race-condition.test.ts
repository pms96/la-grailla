// AUDIT: condición de carrera (TOCTOU) en POST /api/scan — el ticket se lee una vez y su
// status se evalúa fuera de la escritura; el UPDATE que marca USED filtra solo por `id`,
// no por `status: 'VALID'`. Dos escaneos casi simultáneos del mismo QR pueden ambos
// superar el chequeo de "ya usado" antes de que ninguno confirme su escritura, y ambos
// marcan el ticket como usado + incrementan el aforo — doble entrada admitida.
// Severidad: Alta.
//
// Este test dispara dos escaneos concurrentes del mismo QR con Promise.all. Debe FALLAR
// mientras el bug esté presente (hoy: ambos pueden devolver VALID y currentCount sube en
// 2) y PASAR una vez el update esté condicionado atómicamente al estado 'VALID' (p.ej.
// updateMany({ where: { id, status: 'VALID' }, ... })), de forma que solo uno de los dos
// escaneos gane la carrera.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../../tests/helpers/fixtures';
import bcrypt from 'bcryptjs';

const scannerEmail = `scanner-audit-race-${Date.now()}@test.local`;
let scannerUserId: string;

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: scannerUserId, role: 'TAQUILLA', email: scannerEmail },
  })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: scanTicket } = await import('@/app/api/scan/route');

function scanRequest(body: unknown, ip: string) {
  return new Request('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('AUDIT — dos escaneos concurrentes del mismo QR no deben admitir doble entrada', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let qrCode: string;
  let ticketId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: scannerEmail, name: 'Scanner Race Audit', hashedPassword: await bcrypt.hash('x', 4), role: 'TAQUILLA' },
    });
    scannerUserId = user.id;

    event = await createTestEvent();
    const ticketType = await createTicketType(event.id);
    qrCode = `QR-RACE-${Date.now()}`;
    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Race',
        buyerLastName: 'Condition',
        buyerEmail: 'race@example.com',
        totalAmount: 10,
        status: 'COMPLETED',
        tickets: { create: { eventId: event.id, ticketTypeId: ticketType.id, qrCode, holderName: 'Race Condition', status: 'VALID' } },
      },
      include: { tickets: true },
    });
    ticketId = order.tickets[0].id;
  });

  afterAll(async () => {
    await prisma.scanLog.deleteMany({ where: { ticketId } });
    await cleanupTestEvent(event.id);
    await prisma.user.delete({ where: { id: scannerUserId } }).catch(() => {});
  });

  it('solo uno de los dos escaneos simultáneos debe devolver VALID', async () => {
    const eventBefore = await prisma.event.findUnique({ where: { id: event.id } });
    const countBefore = eventBefore?.currentCount ?? 0;

    const [resA, resB] = await Promise.all([
      scanTicket(scanRequest({ qrCode, eventId: event.id }, '203.0.113.60')),
      scanTicket(scanRequest({ qrCode, eventId: event.id }, '203.0.113.61')),
    ]);
    const [jsonA, jsonB] = await Promise.all([resA.json(), resB.json()]);
    const results = [jsonA.result, jsonB.result];

    // Comportamiento esperado tras el fix: exactamente un VALID y un DUPLICATE.
    expect(results.filter((r) => r === 'VALID')).toHaveLength(1);
    expect(results.filter((r) => r === 'DUPLICATE')).toHaveLength(1);

    const eventAfter = await prisma.event.findUnique({ where: { id: event.id } });
    expect((eventAfter?.currentCount ?? 0) - countBefore).toBe(1);
  });
});
