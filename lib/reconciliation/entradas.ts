import { getFallbackBaseUrl } from '@/lib/url';
import { escapeHtml as esc } from '@/lib/html-escape';
import type { OrderStatus, TicketStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPaymentProviderByName } from '@/lib/payment-adapter';
import { scheduleOrderEmail } from '@/lib/order-email';
import { hasEventEnded } from '@/lib/active-event';
import { alertOperator, alertPaidButInactiveOrder, logPaymentEvent, paymentMatchesOrder, refundIdempotencyKey, type CompleteOutcome, type PaidInfo } from './shared';
import { alertManuallyRefunded, confirmLatePayment, finishLateRefund, lateRefundMarker } from './late-payment';
import { closeSessionBeforeCancel } from './close-session';
import { releasePendingSlot } from '@/lib/rate-limit';

/* Reconciliación de pedidos de ENTRADAS (módulo Entradas): marcar pagado, liberar aforo al caducar, anular y reembolsar. Los pedidos de
 * la tienda están en ./tienda.ts: una web con solo Tienda no carga nada de entradas (PDF, wallet, aforo). */

// Compartido entre el webhook de Stripe y la reconciliación periódica de
// SumUp (app/api/cron/reconcile-payments) — ambos necesitan exactamente la
// misma operación "marcar como pagado" y no tiene sentido mantenerla
// duplicada en dos sitios.
// Idempotente y seguro ante concurrencia: la transición PENDING -> COMPLETED
// se hace con un updateMany condicionado al estado actual (atómico a nivel
// de fila en la base de datos), no con un "leer estado, decidir, escribir"
// — así, si el webhook y el cron (o dos reintentos del webhook) llegan casi
// a la vez, solo uno de los dos gana la transición y el resto no reescribe
// nada. Tras completar (o si ya estaba COMPLETED sin email), programa el envío
// de las entradas: el comprador no debe depender de volver a /confirmacion.
export async function completeOrder(orderId: string, baseUrl?: string, paid?: PaidInfo, opts: { emailInline?: boolean } = {}): Promise<CompleteOutcome> {
  // Si la pasarela dice cuánto cobró y no cuadra con el pedido, no se completa (ver paymentMatchesOrder).
  if (!(await paymentMatchesOrder('entradas', orderId, paid))) return 'amount_mismatch';
  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status: 'COMPLETED' },
    });
    if (count > 0) {
      await tx.ticket.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'VALID' } });
    }
    const order = await tx.order.findUnique({ where: { id: orderId } });
    return { transitioned: count > 0, order };
  });

  const { transitioned, order } = result;
  if (!order) return 'missing';
  let outcome: CompleteOutcome = transitioned ? 'completed' : 'already_completed';
  if (transitioned) await releasePendingSlot(orderId); // ya no está sin pagar: libera su hueco del cupo por IP
  if (!transitioned && order.status === 'CANCELLED') {
    // P0-05: el pago llegó DESPUÉS de liberar/anular el pedido. Se reactiva si hay plazas y, si no, se devuelve el dinero.
    outcome = await handleLatePayment(order);
    if (outcome !== 'revived' && outcome !== 'already_completed') return outcome;
  } else if (!transitioned && order.status !== 'COMPLETED') {
    await alertPaidButInactiveOrder('entradas', orderId, order.status);
    return 'inactive';
  }

  // P0-08: el email (PDF + pases + SMTP) sale de la ruta crítica —la pasarela recibe su 200 sin esperarlo— y por el ÚNICO punto de envío, que
  // reclama una concesión atómica (webhook, verificación al abrir la confirmación y cron pueden llegar a la vez) y deja rastro del intento. Si
  // la función se corta antes de enviar, el barrido del cron lo recupera. `emailInline`: el cron, que ya acota su concurrencia y su tiempo.
  await scheduleOrderEmail('entradas', orderId, { baseUrl: baseUrl ?? getFallbackBaseUrl(), inline: opts.emailInline });

  try {
    const { checkCapacityAlerts } = await import('@/lib/capacity-alerts');
    await checkCapacityAlerts(order.eventId);
  } catch (error) {
    console.error(
      `[completeOrder] Error alertas aforo ${order.eventId}:`,
      error instanceof Error ? error.message : error
    );
  }
  return outcome;
}

type ReviveResult = 'revived' | 'no_capacity' | 'not_cancelled';

/**
 * Reactiva un pedido CANCELLED cuyo pago acaba de confirmarse, si TODAVÍA hay plazas. Se hace dentro de una transacción con el mismo
 * cerrojo por evento que usa la compra (`pg_advisory_xact_lock(hashtext(eventId))`): la comprobación de aforo y la reactivación no pueden
 * competir con una venta nueva ni con otra reactivación. La transición CANCELLED → COMPLETED es condicionada (`updateMany`): dos entregas
 * simultáneas no lo reaniman dos veces. Si no cabe, deja la marca de «reembolsar» y no cambia nada más.
 */
export async function reviveOrder(orderId: string): Promise<ReviveResult> {
  return prisma.$transaction(
    async (tx) => {
      const head = await tx.order.findUnique({ where: { id: orderId }, select: { eventId: true } });
      if (!head) return 'not_cancelled';
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${head.eventId}))`;

      const order = await tx.order.findUnique({ where: { id: orderId }, include: { tickets: true, event: true } });
      if (!order || order.status !== 'CANCELLED') return 'not_cancelled';
      if (await tx.processedWebhookEvent.findUnique({ where: { id: lateRefundMarker(orderId) } })) return 'no_capacity';

      const toRevive = order.tickets.filter((t) => t.status === 'CANCELLED');
      const quantityByType = new Map<string, number>();
      for (const ticket of toRevive) {
        if (ticket.ticketTypeId) quantityByType.set(ticket.ticketTypeId, (quantityByType.get(ticket.ticketTypeId) ?? 0) + 1);
      }

      // Un evento cancelado no reanima entradas: el pago tardío se reembolsa (P1-04), igual que si no cupieran.
      let fits = toRevive.length > 0 && !hasEventEnded(order.event.date) && order.event.status !== 'CANCELLED';
      if (fits) {
        const types = await tx.ticketType.findMany({ where: { id: { in: Array.from(quantityByType.keys()) } } });
        for (const [ticketTypeId, quantity] of quantityByType) {
          const tt = types.find((t) => t.id === ticketTypeId);
          // No se mira `isActive`: la venta se cerró DESPUÉS de que este comprador reservara; lo que cuenta es que quede hueco.
          if (!tt || tt.soldCount + quantity > tt.maxQuantity) fits = false;
        }
        const issued = await tx.ticket.count({ where: { eventId: order.eventId, status: { notIn: ['CANCELLED', 'REFUNDED'] } } });
        if (issued + toRevive.length > order.event.maxCapacity) fits = false;
      }

      if (!fits) {
        await tx.processedWebhookEvent.createMany({ data: [{ id: lateRefundMarker(orderId) }], skipDuplicates: true });
        return 'no_capacity';
      }

      const { count } = await tx.order.updateMany({ where: { id: orderId, status: 'CANCELLED' }, data: { status: 'COMPLETED' } });
      if (count === 0) return 'not_cancelled';
      await tx.ticket.updateMany({ where: { orderId, status: 'CANCELLED' }, data: { status: 'VALID' } });
      for (const [ticketTypeId, quantity] of quantityByType) {
        await tx.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { increment: quantity } } });
      }
      return 'revived';
    },
    // Mismo margen que la compra: con muchos compradores concurrentes la transacción espera turno en el cerrojo del evento.
    { maxWait: 20_000, timeout: 20_000 }
  );
}

/** Pago tardío sobre un pedido CANCELLED: reactivar si cabe; si no, reembolso total. Nunca deja un cobro sin entrega ni sin devolución sin avisar. */
async function handleLatePayment(order: { id: string; eventId: string; buyerName: string; buyerEmail: string; totalAmount: number; paymentProvider: string | null; paymentId: string | null }): Promise<CompleteOutcome> {
  const gateway = await confirmLatePayment('entradas', order);
  // La transición CANCELLED → REFUNDED (condicionada: solo una entrega la hace) y la lectura del estado, para finishLateRefund.
  const claim = async () => {
    const count = await prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({ where: { id: order.id, status: 'CANCELLED' }, data: { status: 'REFUNDED' } });
      if (count > 0) await tx.ticket.updateMany({ where: { orderId: order.id, status: 'CANCELLED' }, data: { status: 'REFUNDED' } });
      return count;
    });
    return count > 0;
  };
  const readStatus = async () => (await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } }))?.status;
  if (gateway.state === 'mismatch') return 'amount_mismatch';
  if (gateway.state === 'not_paid') {
    logPaymentEvent('[late-payment]', { kind: 'entradas', orderId: order.id, reason: 'gateway_says_not_paid', status: gateway.status }, 'warn');
    return 'inactive';
  }
  if (gateway.state === 'unverifiable') {
    await alertOperator({
      kind: 'entradas',
      tag: '[late-payment]',
      orderId: order.id,
      reason: 'unverifiable',
      details: { detail: gateway.reason },
      dedupeKey: `late-unverifiable:${order.id}`,
      subject: `⚠️ Pago sobre un pedido anulado que no se puede comprobar (${order.id.slice(0, 8)})`,
      html:
        `<p>Ha llegado la confirmación de un pago para el pedido <strong>${esc(order.id)}</strong>, que ya estaba anulado, pero no se ha podido comprobar con la pasarela (${esc(gateway.reason)}).</p>` +
        '<p>No se ha reactivado ni reembolsado nada. Revisa el cobro en la pasarela y resuélvelo a mano.</p>',
    });
    return 'late_unresolved';
  }

  if (gateway.state === 'refunded') {
    if (!gateway.ours) {
      await alertManuallyRefunded('entradas', order.id, 'REFUNDED');
      return 'inactive';
    }
    // Lo reembolsó este sistema antes de un corte: solo falta marcar el pedido.
    return finishLateRefund({
      kind: 'entradas',
      order,
      provider: gateway.provider,
      alreadyRefunded: true,
      claim,
      readStatus,
    });
  }

  const revived = await reviveOrder(order.id);
  if (revived === 'revived') {
    logPaymentEvent('[late-payment]', { kind: 'entradas', orderId: order.id, reason: 'revived' }, 'warn');
    return 'revived';
  }
  if (revived === 'not_cancelled') {
    // Otra entrega (el webhook duplicado, el cron) ya lo ha resuelto entre medias.
    const now = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
    return now?.status === 'COMPLETED' ? 'already_completed' : 'inactive';
  }

  // Sin plazas: reembolso total (ver finishLateRefund).
  return finishLateRefund({
    kind: 'entradas',
    order,
    provider: gateway.provider,
    claim,
    readStatus,
  });
}

// Si el checkout expira sin pagarse (el comprador nunca completa el pago),
// hay que soltar el stock reservado en la creación del pedido — si no, las
// entradas de ese carrito quedan "vendidas" para siempre y un evento con
// aforo ajustado puede marcarse como agotado sin haber cobrado nada.
// La transición PENDING -> CANCELLED es atómica (updateMany condicionado al
// estado actual): si completeOrder ya ganó la carrera para este pedido, el
// updateMany afecta 0 filas y no tocamos tickets ni soldCount — evita soltar
// stock que ya pertenece a un pedido pagado.
// Devuelve true si ESTA llamada lo liberó (false: ya no estaba PENDING).
export async function releaseExpiredOrder(orderId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status: 'CANCELLED', idempotencyKey: null },
    });
    if (count === 0) return false;

    const order = await tx.order.findUnique({ where: { id: orderId }, include: { tickets: true } });
    if (!order) return false;

    const quantityByType = new Map<string, number>();
    for (const ticket of order.tickets) {
      if (!ticket.ticketTypeId) continue;
      quantityByType.set(ticket.ticketTypeId, (quantityByType.get(ticket.ticketTypeId) ?? 0) + 1);
    }

    await tx.ticket.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    for (const [ticketTypeId, quantity] of quantityByType.entries()) {
      await tx.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { decrement: quantity } } });
    }
    return true;
  }).then(async (released) => {
    if (released) await releasePendingSlot(orderId); // libera su hueco del cupo de pedidos pendientes por IP
    return released;
  });
}

export type InvalidateOrderResult =
  | { success: true; status: OrderStatus }
  | { success: false; error: string };

/**
 * Cancela o reembolsa un pedido de entradas desde el admin.
 * - Libera stock (soldCount) de tickets aún activos.
 * - En REFUNDED con pago con tarjeta, intenta reembolso en la pasarela primero.
 * - No actúa si el pedido ya está CANCELLED/REFUNDED o si alguna entrada está USED.
 */
export async function invalidateOrder(
  orderId: string,
  mode: 'CANCELLED' | 'REFUNDED'
): Promise<InvalidateOrderResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { tickets: true },
  });
  if (!order) return { success: false, error: 'Pedido no encontrado' };
  if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
    return { success: false, error: 'Este pedido ya está anulado' };
  }
  if ((order.tickets ?? []).some((t) => t.status === 'USED')) {
    return { success: false, error: 'Hay entradas ya usadas; no se puede anular' };
  }

  // "Cancelar" (a diferencia de "Reembolsar") nunca ha llamado a la pasarela
  // de pago — libera aforo y anula las entradas, pero el comprador se queda
  // sin su dinero si el pedido ya estaba cobrado. Un pedido COMPLETED pagado
  // de verdad con tarjeta (no mock) solo puede anularse vía REFUNDED, que sí
  // intenta el reembolso antes de tocar nada.
  if (
    mode === 'CANCELLED' &&
    order.status === 'COMPLETED' &&
    order.paymentMethod === 'CARD' &&
    order.paymentProvider &&
    order.paymentProvider !== 'mock'
  ) {
    return {
      success: false,
      error: 'Este pedido ya está pagado con tarjeta — usa "Reembolsar" en vez de "Cancelar" para devolver el dinero al comprador.',
    };
  }

  if (mode === 'REFUNDED' && order.status !== 'COMPLETED') {
    return { success: false, error: 'Solo se pueden reembolsar pedidos completados' };
  }

  // Anular un pedido sin pagar: se cierra su sesión de pago para que el comprador no siga pudiendo pagarlo. Si resulta que ya estaba pagado
  // (el webhook aún no había llegado), no se anula: se completa y se avisa al admin de que use «Reembolsar» si quiere devolverlo.
  if (mode === 'CANCELLED' && order.status === 'PENDING') {
    const { paid } = await closeSessionBeforeCancel('entradas', order);
    if (paid) {
      await completeOrder(orderId, undefined, paid);
      return { success: false, error: 'El comprador ya había pagado este pedido: se ha marcado como pagado y no se ha anulado. Usa "Reembolsar" si quieres devolverle el dinero.' };
    }
  }

  // TOCTOU: hasta aquí solo se ha LEÍDO el pedido — dos peticiones
  // concurrentes (doble clic en "Reembolsar", dos admins a la vez) pasarían
  // ambas los checks de arriba antes de que ninguna escriba nada, y las dos
  // acabarían llamando a la pasarela y decrementando soldCount por
  // duplicado. Se reclama la transición de estado con un updateMany
  // condicionado al status exacto que se acaba de leer (compare-and-swap):
  // si otra petición ya cambió el estado entre la lectura y este punto,
  // count será 0 y se aborta sin tocar la pasarela ni el stock.
  const claim = await prisma.order.updateMany({
    where: { id: orderId, status: order.status },
    data: { status: mode, idempotencyKey: null },
  });
  if (claim.count === 0) {
    return { success: false, error: 'El pedido cambió de estado mientras se procesaba; vuelve a intentarlo' };
  }
  // Anulado o reembolsado: ya no está sin pagar, así que libera su hueco del cupo de pedidos pendientes por IP.
  await releasePendingSlot(orderId);

  if (mode === 'REFUNDED' && order.paymentMethod === 'CARD' && order.paymentProvider && order.paymentId && order.paymentProvider !== 'mock') {
    try {
      const provider = await getPaymentProviderByName(order.paymentProvider);
      const refund = await provider.refund(order.paymentId, order.totalAmount, refundIdempotencyKey(order.id));
      if (!refund.success) {
        await prisma.order.update({ where: { id: orderId }, data: { status: order.status } });
        return { success: false, error: refund.error ?? 'El reembolso en la pasarela ha fallado' };
      }
    } catch (err) {
      await prisma.order.update({ where: { id: orderId }, data: { status: order.status } });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Error al reembolsar en la pasarela',
      };
    }
  }

  const activeStatuses: TicketStatus[] = ['PENDING', 'VALID'];
  const quantityByType = new Map<string, number>();
  for (const ticket of order.tickets ?? []) {
    if (!activeStatuses.includes(ticket.status)) continue;
    if (!ticket.ticketTypeId) continue;
    quantityByType.set(ticket.ticketTypeId, (quantityByType.get(ticket.ticketTypeId) ?? 0) + 1);
  }

  const ticketStatus: TicketStatus = mode === 'REFUNDED' ? 'REFUNDED' : 'CANCELLED';

  await prisma.$transaction([
    prisma.ticket.updateMany({
      where: { orderId, status: { in: activeStatuses } },
      data: { status: ticketStatus },
    }),
    ...Array.from(quantityByType.entries()).map(([ticketTypeId, quantity]) =>
      prisma.ticketType.update({
        where: { id: ticketTypeId },
        data: { soldCount: { decrement: quantity } },
      })
    ),
  ]);

  return { success: true, status: mode };
}
