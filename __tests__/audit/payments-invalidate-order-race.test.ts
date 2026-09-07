// AUDIT: PAY-04 — TOCTOU en invalidateOrder/invalidateShopOrder. La función leía
// el pedido, decidía qué hacer (incluido llamar a la pasarela de pago) y solo al
// final escribía el nuevo estado, sin condicionar esa escritura al estado leído
// al principio. Dos llamadas concurrentes sobre el MISMO pedido (doble clic en
// "Reembolsar"/"Cancelar" en el admin, o dos admins a la vez) pasaban ambas los
// checks de "¿ya está anulado?" antes de que ninguna escribiera nada, y las dos
// acababan decrementando soldCount con la misma foto de tickets leída al
// principio — doble liberación de aforo aunque el pedido solo se anula una vez.
//
// Se arregla reclamando la transición de estado con un updateMany condicionado
// al status exacto leído (compare-and-swap), igual que ya hacían
// completeOrder/releaseExpiredOrder, antes de tocar la pasarela o el stock.
//
// Este test dispara dos invalidateOrder(orderId, 'CANCELLED') concurrentes con
// Promise.all sobre un pedido con 2 entradas VALID. Debe FALLAR mientras el bug
// esté presente (hoy: las dos llamadas "tienen éxito" y soldCount se decrementa
// en 4 en vez de 2) y PASAR una vez la segunda llamada se rechace por
// compare-and-swap y soldCount se decremente solo una vez.
import { describe, it, expect } from 'vitest';
import { prisma } from '@/lib/prisma';
import { invalidateOrder } from '@/lib/order-reconciliation';
import { createTestEvent, createTicketType, cleanupTestEvent } from '../../tests/helpers/fixtures';

describe('AUDIT — dos invalidateOrder concurrentes sobre el mismo pedido no deben decrementar soldCount por duplicado', () => {
  it('solo una de las dos llamadas concurrentes tiene éxito y soldCount baja una sola vez', async () => {
    const event = await createTestEvent();
    const ticketType = await createTicketType(event.id, { maxQuantity: 100 });
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { soldCount: 2 } });

    const order = await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: 'Test',
        buyerLastName: 'Audit',
        buyerEmail: 'audit-pay04@test.local',
        totalAmount: 20,
        commission: 0,
        paymentMethod: 'CASH',
        status: 'COMPLETED',
        channel: 'TAQUILLA',
      },
    });
    await prisma.ticket.createMany({
      data: [1, 2].map((n) => ({
        orderId: order.id,
        eventId: event.id,
        ticketTypeId: ticketType.id,
        qrCode: `audit-pay04-${Date.now()}-${n}`,
        holderName: 'Test Audit',
        status: 'VALID' as const,
      })),
    });

    const [resultA, resultB] = await Promise.all([
      invalidateOrder(order.id, 'CANCELLED'),
      invalidateOrder(order.id, 'CANCELLED'),
    ]);

    const succeeded = [resultA, resultB].filter((r) => r.success);
    const failed = [resultA, resultB].filter((r) => !r.success);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const refreshedTicketType = await prisma.ticketType.findUniqueOrThrow({ where: { id: ticketType.id } });
    expect(refreshedTicketType.soldCount).toBe(0);

    const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refreshedOrder.status).toBe('CANCELLED');

    await prisma.ticket.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
    await cleanupTestEvent(event.id);
  });
});
