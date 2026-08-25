import type { OrderStatus, Prisma } from '@prisma/client';

const ORDER_STATUSES: OrderStatus[] = ['PENDING', 'COMPLETED', 'CANCELLED', 'REFUNDED'];

export type OrdersFilterParams = {
  q?: string;
  status?: string;
  eventId?: string;
  emailFailed?: boolean;
};

// Compartido por app/api/admin/orders (listado) y app/api/admin/export
// (CSV) para que el CSV descargado coincida siempre con lo que se ve
// filtrado en pantalla, en vez de mantener el mismo criterio duplicado en
// dos sitios que podían divergir.
export function buildOrdersWhere(params: OrdersFilterParams): Prisma.OrderWhereInput {
  const q = (params.q ?? '').trim();
  const status = ORDER_STATUSES.includes(params.status as OrderStatus)
    ? (params.status as OrderStatus)
    : undefined;

  return {
    ...(status ? { status } : {}),
    ...(params.eventId ? { eventId: params.eventId } : {}),
    ...(params.emailFailed
      ? {
          status: 'COMPLETED',
          emailSentAt: null,
        }
      : {}),
    ...(q
      ? {
          OR: [
            { buyerEmail: { contains: q, mode: 'insensitive' } },
            { buyerName: { contains: q, mode: 'insensitive' } },
            { buyerLastName: { contains: q, mode: 'insensitive' } },
            { id: { contains: q, mode: 'insensitive' } },
            { paymentId: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}
