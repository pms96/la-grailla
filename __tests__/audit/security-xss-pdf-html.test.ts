// AUDIT: XSS almacenado en app/api/tickets/[orderId]/pdf-html — el nombre del titular
// (holderName, derivado de buyerName/buyerLastName del checkout público) se interpola
// sin escapar en el HTML servido como text/html. Ese HTML se abre directamente desde
// el panel de taquilla (sesión de staff activa) al imprimir/ver entradas.
// Severidad: Crítica/Alta.
//
// Este test debe FALLAR mientras el bug esté presente (hoy: el script aparece literal
// en el HTML de respuesta) y PASAR una vez se escape holderName (y el resto de campos
// derivados de datos de usuario) igual que ya hace lib/tickets.ts:esc() para el email.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as getPdfHtml } from '@/app/api/tickets/[orderId]/pdf-html/route';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../../tests/helpers/fixtures';
import { signOrderAccess } from '@/lib/access-token';

describe('AUDIT — pdf-html escapa el nombre del titular', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let orderId: string;
  const payload = '<script>alert(1)</script>';

  beforeAll(async () => {
    event = await createTestEvent();
    const ticketType = await createTicketType(event.id);

    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: payload,
        buyerLastName: 'XSS',
        buyerEmail: 'xss-audit@example.com',
        totalAmount: 10,
        status: 'COMPLETED',
        tickets: {
          create: {
            eventId: event.id,
            ticketTypeId: ticketType.id,
            qrCode: `QR-XSS-${Date.now()}`,
            holderName: payload,
            status: 'VALID',
          },
        },
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await cleanupTestEvent(event.id);
  });

  it('no debe incluir <script> sin escapar en el HTML servido', async () => {
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'test-secret-for-access-token-vitest';
    const token = signOrderAccess(orderId);
    const res = await getPdfHtml(new Request(`http://localhost/api/tickets/${orderId}/pdf-html?t=${token}`), {
      params: { orderId },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Comportamiento esperado tras el fix: el payload aparece escapado
    // (&lt;script&gt;...), nunca como una etiqueta <script> real.
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
