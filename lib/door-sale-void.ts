import type { TicketStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAdminAudit, type AuditActor } from '@/lib/admin-audit';
import { checkTemporadaAbiertaTx, parseMotivo } from '@/lib/contabilidad/control';
import { sortedByKey } from '@/lib/lock-order';

/* H-253: anular una venta de taquilla de PUERTA. Una venta «durante el evento» crea las entradas ya usadas, y `invalidateOrder` no anula un pedido con entradas usadas: un error de cantidad
 * o de método de pago solo se corregía con un ingreso negativo manual y la caja del día quedaba inflada. Esto lo corrige de verdad, en UNA transacción y con el mismo cerrojo por evento que la
 * venta de taquilla (si no, una venta y una anulación simultáneas leerían aforo o stock obsoleto):
 *   - el pedido pasa a CANCELLED (con comprobación de estado: dos anulaciones a la vez solo aplican una);
 *   - sus entradas activas (sin usar y usadas) pasan a CANCELLED;
 *   - lo vendido por tipo (`soldCount`) baja una vez por entrada activa;
 *   - el aforo en puerta (`Event.currentCount`) baja una vez por entrada USADA, sin pasar de cero;
 *   - queda el rastro (quién, cuándo y el motivo) escrito en la misma transacción: no hay anulación sin fila de auditoría.
 * La caja del día, las ventas por día y las estadísticas se corrigen solas: todas cuentan pedidos COMPLETED.
 * Lo que NO hace: devolver el dinero (es efectivo o datáfono, se devuelve en caja) ni anular ventas pagadas por una pasarela (esas se reembolsan). Una temporada CERRADA lo bloquea (423):
 * anular cambia su margen, como anular un ingreso. Solo el propietario puede (lo decide quien llama). */

export type VoidDoorSaleFailure = {
  ok: false;
  status: 400 | 404 | 409 | 422 | 423;
  code: 'motivo' | 'not_found' | 'already_voided' | 'not_completed' | 'not_door_sale' | 'gateway_payment' | 'temporada_cerrada' | 'temporada_no_encontrada';
  error: string;
};
export type VoidDoorSaleOutcome = { ok: true; totalAmount: number; paymentMethod: string; tickets: number; entered: number } | VoidDoorSaleFailure;

class VoidRejected extends Error {
  constructor(readonly failure: VoidDoorSaleFailure) {
    super(failure.error);
  }
}
const reject = (status: VoidDoorSaleFailure['status'], code: VoidDoorSaleFailure['code'], error: string): never => {
  throw new VoidRejected({ ok: false, status, code, error });
};

const ACTIVE: TicketStatus[] = ['PENDING', 'VALID', 'USED'];

/** ¿Es una venta que `voidDoorSale` aceptaría (antes de mirar la temporada)? Pura: la usa la pantalla para decidir si enseña el botón. El permiso del propietario lo comprueba quien llama. */
export function isVoidableDoorSale(order: { channel: string; status: string; paymentProvider?: string | null; paymentId?: string | null; tickets?: { status: string }[] }): boolean {
  if (order.channel !== 'TAQUILLA' || order.status !== 'COMPLETED') return false;
  if (order.paymentProvider && order.paymentProvider !== 'mock' && order.paymentId) return false;
  return (order.tickets ?? []).some((t) => t.status === 'USED');
}

export async function voidDoorSale(orderId: string, rawReason: unknown, audit: { actor: AuditActor; request?: Request }): Promise<VoidDoorSaleOutcome> {
  const motivo = parseMotivo(rawReason);
  if (!motivo.ok) return { ok: false, status: 400, code: 'motivo', error: motivo.error };

  // Hace falta el evento para tomar su cerrojo antes de releer el pedido.
  const head = await prisma.order.findUnique({ where: { id: orderId }, select: { eventId: true } });
  if (!head) return { ok: false, status: 404, code: 'not_found', error: 'Pedido no encontrado' };

  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${head.eventId}))`; // el mismo cerrojo por evento que app/api/taquilla/sale

        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { tickets: { select: { id: true, status: true, ticketTypeId: true } }, event: { select: { temporadaId: true } } },
        });
        if (!order) return reject(404, 'not_found', 'Pedido no encontrado');
        if (order.status === 'CANCELLED' || order.status === 'REFUNDED') return reject(409, 'already_voided', 'Este pedido ya está anulado');
        if (order.status !== 'COMPLETED') return reject(422, 'not_completed', 'Solo se puede anular una venta completada');
        if (order.channel !== 'TAQUILLA') return reject(422, 'not_door_sale', 'Solo se pueden anular así las ventas de taquilla');
        if (order.paymentProvider && order.paymentProvider !== 'mock' && order.paymentId) {
          return reject(422, 'gateway_payment', 'Esta venta se pagó por la pasarela: hay que reembolsarla, no anularla como venta de puerta');
        }
        const active = order.tickets.filter((t) => ACTIVE.includes(t.status));
        const entered = active.filter((t) => t.status === 'USED').length;
        if (entered === 0) return reject(422, 'not_door_sale', 'Esta venta no tiene entradas usadas: usa «Cancelar pedido»');

        if (order.event.temporadaId) {
          const check = await checkTemporadaAbiertaTx(tx, order.event.temporadaId); // con la temporada bloqueada hasta el final: un cierre en curso espera
          if (!check.ok) return reject(check.status, check.code, check.error);
        }

        const swap = await tx.order.updateMany({ where: { id: orderId, status: 'COMPLETED' }, data: { status: 'CANCELLED', idempotencyKey: null } });
        if (swap.count === 0) return reject(409, 'already_voided', 'El pedido cambió de estado mientras se procesaba; vuelve a intentarlo');

        await tx.ticket.updateMany({ where: { id: { in: active.map((t) => t.id) } }, data: { status: 'CANCELLED' } });
        const byType = new Map<string, number>();
        for (const t of active) if (t.ticketTypeId) byType.set(t.ticketTypeId, (byType.get(t.ticketTypeId) ?? 0) + 1);
        for (const [ticketTypeId, quantity] of sortedByKey(byType, ([id]) => id)) { // orden fijo de bloqueo (H-181)
          await tx.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { decrement: quantity } } });
        }
        // El aforo en puerta cuenta a quien ha entrado: baja por cada entrada USADA, y nunca por debajo de cero (otro ajuste manual pudo bajarlo antes).
        await tx.$executeRaw`UPDATE "Event" SET "currentCount" = GREATEST("currentCount" - ${entered}, 0) WHERE "id" = ${order.eventId}`;

        await recordAdminAudit(tx, audit.actor, audit.request, {
          action: 'order.void_door_sale',
          targetType: 'Order',
          targetId: orderId,
          meta: { motivo: motivo.motivo, totalAmount: Number(order.totalAmount), paymentMethod: order.paymentMethod, entradas: active.length, entradasUsadas: entered, estadoAnterior: order.status },
        });

        return { ok: true as const, totalAmount: Number(order.totalAmount), paymentMethod: order.paymentMethod, tickets: active.length, entered };
        // Misma espera que la venta de taquilla: el cerrojo cuenta dentro del `timeout` y, tras una cola de compras, los 5 s por defecto de Prisma darían P2028 (H-218).
      },
      { maxWait: 20_000, timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof VoidRejected) return error.failure;
    throw error;
  }
}
