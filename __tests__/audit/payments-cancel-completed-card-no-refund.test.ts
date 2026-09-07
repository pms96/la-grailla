// AUDIT: invalidateOrder() con mode='CANCELLED' no reembolsa un pedido de entradas ya
// COMPLETED pagado con tarjeta — solo mode='REFUNDED' llama a la pasarela de pago. Un
// admin puede pulsar "Cancelar" (en vez de "Reembolsar") sobre un pedido ya cobrado:
// las entradas se anulan y el aforo se libera, pero el comprador nunca recibe el dinero.
// Severidad: Crítica.
//
// Este test debe FALLAR mientras el bug esté presente (hoy: invalidateOrder acepta
// 'CANCELLED' sobre un pedido COMPLETED con tarjeta sin ninguna comprobación) y PASAR
// una vez se bloquee esa combinación (forzando 'REFUNDED', que sí intenta el reembolso
// en la pasarela) o se dispare el reembolso automáticamente también en modo CANCELLED.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { invalidateOrder } from '@/lib/order-reconciliation';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../../tests/helpers/fixtures';

describe('AUDIT — cancelar un pedido pagado con tarjeta no debe saltarse el reembolso', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let orderId: string;

  beforeAll(async () => {
    event = await createTestEvent();
    const ticketType = await createTicketType(event.id, { maxQuantity: 5 });

    // Pedido ya cobrado con tarjeta a través de una pasarela real (no 'mock'), tal y
    // como quedaría en producción tras un checkout con Stripe/SumUp completado.
    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: '[TEST] Comprador',
        buyerLastName: 'Pagado',
        buyerEmail: 'pagado-audit@example.com',
        totalAmount: 10,
        status: 'COMPLETED',
        paymentMethod: 'CARD',
        paymentProvider: 'stripe',
        paymentId: 'pi_test_audit_123',
        tickets: {
          create: {
            eventId: event.id,
            ticketTypeId: ticketType.id,
            qrCode: `QR-REFUND-${Date.now()}`,
            holderName: 'Comprador Pagado',
            status: 'VALID',
          },
        },
      },
    });
    orderId = order.id;
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: 1 } });
  });

  afterAll(async () => {
    await cleanupTestEvent(event.id);
  });

  it('rechaza cancelar (en vez de reembolsar) un pedido COMPLETED pagado con tarjeta real', async () => {
    const result = await invalidateOrder(orderId, 'CANCELLED');

    // Comportamiento esperado tras el fix: no se permite "cancelar" sin más un pedido
    // ya cobrado por tarjeta — hay que forzar el flujo de reembolso real.
    expect(result.success).toBe(false);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('COMPLETED');
  });
});
