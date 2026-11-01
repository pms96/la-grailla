import { EVENT_TIMEZONE } from '@/lib/event-time';

/* CSV de pedidos de tienda pensado para Excel en español: separador `;`, decimales con coma, UTF-8 con BOM y fechas en hora de Madrid
 * (el servidor corre en UTC). Pura: la usa la ruta de exportación y sus tests. */

export const SHOP_ORDERS_CSV_MAX = 5000;

export const SHOP_ORDERS_CSV_HEADERS = [
  'pedido',
  'fecha',
  'estado',
  'nombre',
  'email',
  'telefono',
  'direccion',
  'codigo_postal',
  'ciudad',
  'producto',
  'talla',
  'color',
  'cantidad',
  'precio_unitario',
  'importe_linea',
  'total_pedido',
  'total_cobrado',
  'seguimiento',
  'notas',
] as const;

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  PAID: 'Pagado',
  PROCESSING: 'Procesando',
  SHIPPED: 'Enviado',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Reembolsado',
};

/** Una celda de texto: neutraliza fórmulas (=, +, -, @, tab, retorno) con un apóstrofo y entrecomilla si hay `;`, comillas o saltos de línea. */
export function csvText(value: unknown): string {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Teléfono: el escudo de fórmulas lo corrompía (`+34600111222` salía como `'+34600111222` y en CSV el apóstrofo es literal, H-138). Lo que son solo dígitos,
 * espacios y un «+» inicial no puede ser una fórmula peligrosa (no hay funciones ni referencias): sale sin espacios, que es como lo lee una etiqueta de envío.
 * Cualquier otra cosa pasa por `csvText`, con el escudo.
 */
export function csvPhone(value: unknown): string {
  const s = String(value ?? '');
  return /^\+?[0-9][0-9 ]*$/.test(s) ? s.replace(/ /g, '') : csvText(s);
}

/** Importe con coma decimal y dos decimales («12,50»). Va sin el escudo de fórmulas: es un número, no texto de un comprador. */
export function csvMoney(value: unknown): string {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(2).replace('.', ',');
}

/** «dd/mm/aaaa hh:mm» en hora de Madrid, estable entre entornos (no depende del locale del servidor). */
export function formatMadridDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: EVENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

/** Fecha «aaaa-mm-dd» del día de Madrid (nombre del fichero). */
export function madridDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export type ShopOrderCsvInput = {
  id: string;
  createdAt: Date;
  status: string;
  buyerName: string;
  buyerEmail: string;
  shippingPhone: string | null;
  shippingAddress: string;
  shippingCity: string;
  shippingZip: string;
  totalAmount: unknown;
  trackingNumber: string | null;
  notes: string | null;
  items: { quantity: number; unitPrice: unknown; size: string | null; color: string | null; product: { name: string } | null }[];
};

/**
 * Una fila por línea de pedido (así el vendedor ve producto, talla y color de cada artículo). Los datos del pedido se repiten en cada
 * línea, salvo los totales, que solo van en la primera para que sumar la columna no cuente el pedido varias veces.
 * Sin filtro de estado salen también pendientes, cancelados y reembolsados: `total_pedido` es el importe del pedido sea cual sea su estado y
 * `total_cobrado` solo cuenta los que ya son dinero (pagado, procesando, enviado, entregado). La columna que se puede sumar es `total_cobrado` (H-137).
 */
const COBRADOS = new Set(['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED']);

export function shopOrdersToCsv(orders: ShopOrderCsvInput[]): string {
  const lines: string[] = [SHOP_ORDERS_CSV_HEADERS.join(';')];
  for (const o of orders) {
    const head = [
      csvText(o.id),
      csvText(formatMadridDateTime(o.createdAt)),
      csvText(STATUS_LABELS[o.status] ?? o.status),
      csvText(o.buyerName),
      csvText(o.buyerEmail),
      csvPhone(o.shippingPhone),
      csvText(o.shippingAddress),
      csvText(o.shippingZip),
      csvText(o.shippingCity),
    ];
    const tail = [csvText(o.trackingNumber), csvText(o.notes)];
    const items = o.items.length > 0 ? o.items : [null];
    items.forEach((item, i) => {
      lines.push(
        [
          ...head,
          csvText(item?.product?.name),
          csvText(item?.size),
          csvText(item?.color),
          item ? String(item.quantity) : '',
          item ? csvMoney(item.unitPrice) : '',
          item ? csvMoney(Number(item.unitPrice) * item.quantity) : '',
          i === 0 ? csvMoney(o.totalAmount) : '',
          i === 0 ? csvMoney(COBRADOS.has(o.status) ? o.totalAmount : 0) : '',
          ...tail,
        ].join(';')
      );
    });
  }
  // BOM para que Excel abra el UTF-8 con tildes; CRLF como espera Excel.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
