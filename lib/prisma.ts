import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const basePrisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = basePrisma;

// DATA-01: los 14 campos monetarios del esquema son Decimal(10,2) en Postgres
// (evita el redondeo binario acumulativo de Float en sumas/aggregate a nivel
// de base de datos — el problema real que motivó la migración), pero
// Prisma.Decimal no es un number: no admite +/-/* directos, y JSON.stringify
// lo serializa como STRING vía su toJSON(), lo que rompería en silencio toda
// la aritmética y las respuestas de API existentes en el resto del código
// (decenas de sitios, auditados uno a uno antes de este cambio). En vez de
// tocar cada sitio, esta extensión convierte cada campo a number en el
// momento de leerlo de Prisma — el resto del código sigue viendo exactamente
// los mismos numbers que antes, sin ningún cambio de comportamiento.
// Excepción real (no cubierta por esta extensión): los resultados de
// aggregate()/groupBy() (_sum/_avg/_min/_max) no son instancias de modelo y
// no pasan por `result`, así que siguen siendo Decimal — los pocos sitios que
// los usan (stats, resumen de gastos) convierten explícitamente con
// `.toNumber()` en el propio código de la ruta.
function toNumber(value: { toNumber(): number }): number {
  return value.toNumber();
}

export const prisma = basePrisma.$extends({
  result: {
    ticketType: {
      price: { needs: { price: true }, compute: (m) => toNumber(m.price) },
    },
    order: {
      totalAmount: { needs: { totalAmount: true }, compute: (m) => toNumber(m.totalAmount) },
      commission: { needs: { commission: true }, compute: (m) => toNumber(m.commission) },
    },
    product: {
      price: { needs: { price: true }, compute: (m) => toNumber(m.price) },
    },
    shopOrder: {
      totalAmount: { needs: { totalAmount: true }, compute: (m) => toNumber(m.totalAmount) },
    },
    shopOrderItem: {
      unitPrice: { needs: { unitPrice: true }, compute: (m) => toNumber(m.unitPrice) },
    },
    articulo: {
      ivaPercent: { needs: { ivaPercent: true }, compute: (m) => toNumber(m.ivaPercent) },
    },
    precioArticulo: {
      precioSinIva: { needs: { precioSinIva: true }, compute: (m) => toNumber(m.precioSinIva) },
      descuentoPercent: { needs: { descuentoPercent: true }, compute: (m) => toNumber(m.descuentoPercent) },
    },
    lineaPedido: {
      precioSinIva: { needs: { precioSinIva: true }, compute: (m) => toNumber(m.precioSinIva) },
      descuentoPercent: { needs: { descuentoPercent: true }, compute: (m) => toNumber(m.descuentoPercent) },
      ivaPercent: { needs: { ivaPercent: true }, compute: (m) => toNumber(m.ivaPercent) },
    },
    gasto: {
      importeSinIva: { needs: { importeSinIva: true }, compute: (m) => toNumber(m.importeSinIva) },
      ivaPercent: { needs: { ivaPercent: true }, compute: (m) => toNumber(m.ivaPercent) },
    },
  },
});

// El cliente extendido no es estructuralmente el mismo tipo que
// `Prisma.TransactionClient` (que no conoce la extensión `result` de arriba)
// — una función que reciba el `tx` de `prisma.$transaction(async (tx) => ...)`
// como parámetro debe tipar ese parámetro con esto, no con
// `Prisma.TransactionClient`, o TypeScript rechaza la llamada real aunque en
// tiempo de ejecución sea perfectamente compatible.
export type PrismaTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// Mismo motivo que arriba: `Prisma.EventGetPayload<{ include: { ticketTypes:
// true } }>` describe el cliente SIN extender (ticketTypes[].price: Decimal)
// y no coincide con lo que de verdad devuelve `prisma.event.findMany({
// include: { ticketTypes: ... } })` (price: number). Se deriva del cliente
// extendido para que las páginas públicas que listan eventos con sus tipos
// de entrada compilen contra la forma real.
export type EventWithTicketTypes = NonNullable<
  Awaited<ReturnType<typeof prisma.event.findFirst<{ include: { ticketTypes: true } }>>>
>;

// Para tipar en componentes 'use client' datos ya recibidos por fetch(...).
// then(r => r.json()): esos campos monetarios llegan como number (mismo JSON
// que antes de esta migración), pero un tipo de Prisma importado directo de
// '@prisma/client' (no del cliente extendido) seguiría describiéndolos como
// Decimal. Evita repetir `Omit<T, K> & { [K]: number }` en cada componente.
export type WithNumberFields<T, K extends keyof T> = Omit<T, K> & { [P in K]: number };
