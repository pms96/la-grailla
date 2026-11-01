import { csvMoney, csvText, formatMadridDateTime } from '@/lib/shop-orders-csv';
import { displayBuyerEmail } from '@/lib/placeholder-email';

/* CSV de ventas (pedidos de entradas) y de asistentes, con la misma convención que el de tienda y pensado para Excel en español: separador «;», coma decimal,
 * UTF-8 con BOM, CRLF y fechas en hora de Madrid (el servidor corre en UTC). Pura: la usa la ruta de exportación y sus tests (H-137). */

/** Topes: si el filtro devuelve más, la ruta responde 413 y pide filtrar. Nunca se trunca en silencio. */
export const ORDERS_CSV_MAX = 5000;
export const TICKETS_CSV_MAX = 10000;

export const ORDERS_CSV_HEADERS = [
  'id',
  'fecha',
  'estado',
  'evento',
  'nombre',
  'apellidos',
  'email',
  'canal',
  'metodo_pago',
  'entradas',
  'importe',
  'importe_cobrado',
  'comision',
] as const;

export const ATTENDEES_CSV_HEADERS = ['ticket_id', 'evento', 'titular', 'tipo', 'estado', 'entrada', 'qr', 'pedido_id', 'comprador', 'email', 'canal'] as const;

const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  COMPLETED: 'Completado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Reembolsado',
};

type Money = { toFixed(digits: number): string };

export type OrderCsvInput = {
  id: string;
  createdAt: Date;
  status: string;
  event: { name: string } | null;
  buyerName: string;
  buyerLastName: string;
  buyerEmail: string;
  channel: string;
  paymentMethod: string;
  totalAmount: Money;
  commission: Money;
  _count: { tickets: number };
};

const toCsv = (headers: readonly string[], rows: string[][]) => '﻿' + [headers.join(';'), ...rows.map((r) => r.join(';'))].join('\r\n') + '\r\n';

/**
 * `importe` es el total del pedido, sea cual sea su estado (con el filtro «Todos» salen también los cancelados y reembolsados, que ya no son dinero).
 * `importe_cobrado` solo cuenta lo completado: es la columna que se puede sumar.
 */
export function ordersToCsv(orders: OrderCsvInput[]): string {
  return toCsv(
    ORDERS_CSV_HEADERS,
    orders.map((o) => [
      csvText(o.id),
      csvText(formatMadridDateTime(o.createdAt)),
      csvText(ORDER_STATUS_LABELS[o.status] ?? o.status),
      csvText(o.event?.name),
      csvText(o.buyerName),
      csvText(o.buyerLastName),
      csvText(displayBuyerEmail(o.buyerEmail, o.channel)),
      csvText(o.channel),
      csvText(o.paymentMethod),
      String(o._count.tickets),
      csvMoney(o.totalAmount.toFixed(2)),
      o.status === 'COMPLETED' ? csvMoney(o.totalAmount.toFixed(2)) : csvMoney(0),
      csvMoney(o.commission.toFixed(2)),
    ])
  );
}

export type AttendeeCsvInput = {
  id: string;
  event: { name: string } | null;
  holderName: string;
  ticketType: { name: string } | null;
  status: string;
  entryTime: Date | null;
  qrCode: string;
  order: { id: string; buyerName: string; buyerLastName: string; buyerEmail: string; channel: string } | null;
};

export function attendeesToCsv(tickets: AttendeeCsvInput[]): string {
  return toCsv(
    ATTENDEES_CSV_HEADERS,
    tickets.map((t) => [
      csvText(t.id),
      csvText(t.event?.name),
      csvText(t.holderName),
      csvText(t.ticketType?.name ?? 'General'),
      csvText(t.status),
      csvText(t.entryTime ? formatMadridDateTime(t.entryTime) : ''),
      csvText(t.qrCode),
      csvText(t.order?.id),
      csvText(`${t.order?.buyerName ?? ''} ${t.order?.buyerLastName ?? ''}`.trim()),
      csvText(displayBuyerEmail(t.order?.buyerEmail, t.order?.channel)),
      csvText(t.order?.channel),
    ])
  );
}
