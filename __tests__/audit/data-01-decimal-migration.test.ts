// AUDIT: DATA-01 — los 14 campos monetarios del esquema eran Float
// (double precision en Postgres), lo que provoca errores de redondeo binario
// acumulativos en sumas/multiplicaciones de dinero — descuadres contables
// reales, especialmente en SUM()/aggregate() a nivel de base de datos
// (Gasto/LineaPedido, Order.totalAmount con Stripe/SumUp).
//
// Se migran a Decimal(10,2) en Postgres. Como Prisma.Decimal no es un number
// (no admite +/-/* directos y JSON.stringify lo serializa como string, no
// como number — rompería en silencio decenas de sitios de aritmética y
// respuestas de API ya existentes), se añade una extensión de Prisma Client
// en lib/prisma.ts que convierte cada uno de estos 14 campos a number en el
// momento de leerlo — el resto del código sigue viendo exactamente los
// mismos numbers que antes, sin cambiar su comportamiento.
//
// Este test verifica dos cosas por separado:
// 1) el esquema real en Postgres usa NUMERIC(10,2) en los 14 campos (la
//    correción real del problema: SUM/aggregate a nivel de BD ya no acumula
//    error de redondeo binario);
// 2) la extensión de lib/prisma.ts sigue entregando number (no Decimal) en
//    cada uno de los 9 modelos afectados, para que ningún consumidor del
//    resto de la app (aritmética, .toFixed(), respuestas JSON) se rompa.
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';

type ColumnCheck = { table: string; column: string };

const DECIMAL_COLUMNS: ColumnCheck[] = [
  { table: 'TicketType', column: 'price' },
  { table: 'Order', column: 'totalAmount' },
  { table: 'Order', column: 'commission' },
  { table: 'Product', column: 'price' },
  { table: 'ShopOrder', column: 'totalAmount' },
  { table: 'ShopOrderItem', column: 'unitPrice' },
  { table: 'Articulo', column: 'ivaPercent' },
  { table: 'PrecioArticulo', column: 'precioSinIva' },
  { table: 'PrecioArticulo', column: 'descuentoPercent' },
  { table: 'LineaPedido', column: 'precioSinIva' },
  { table: 'LineaPedido', column: 'descuentoPercent' },
  { table: 'LineaPedido', column: 'ivaPercent' },
  { table: 'Gasto', column: 'importeSinIva' },
  { table: 'Gasto', column: 'ivaPercent' },
];

describe('AUDIT — DATA-01: los 14 campos monetarios son NUMERIC(10,2) en Postgres', () => {
  it.each(DECIMAL_COLUMNS)('$table.$column es numeric(10,2)', async ({ table, column }) => {
    const rows = await prisma.$queryRaw<{ data_type: string; numeric_precision: number | null; numeric_scale: number | null }[]>`
      SELECT data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_name = ${table} AND column_name = ${column}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('numeric');
    expect(rows[0].numeric_precision).toBe(10);
    expect(rows[0].numeric_scale).toBe(2);
  });
});

describe('AUDIT — DATA-01: el cliente extendido sigue devolviendo number, no Decimal', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  });

  it('TicketType.price', async () => {
    const event = await prisma.event.create({ data: { name: '[TEST] DATA-01', slug: `test-data01-${Date.now()}`, venue: 'x', city: 'x', date: new Date() } });
    cleanup.push(() => prisma.event.delete({ where: { id: event.id } }));
    const tt = await prisma.ticketType.create({ data: { eventId: event.id, name: 'x', price: 12.34 } });
    cleanup.push(() => prisma.ticketType.delete({ where: { id: tt.id } }));
    expect(typeof tt.price).toBe('number');
    expect(tt.price).toBe(12.34);
  });

  it('Order.totalAmount y Order.commission', async () => {
    const event = await prisma.event.create({ data: { name: '[TEST] DATA-01', slug: `test-data01-${Date.now()}-2`, venue: 'x', city: 'x', date: new Date() } });
    cleanup.push(() => prisma.event.delete({ where: { id: event.id } }));
    const order = await prisma.order.create({ data: { eventId: event.id, buyerName: 'x', buyerLastName: 'x', buyerEmail: 'x@x.com', totalAmount: 36.5, commission: 1.5, status: 'COMPLETED' } });
    cleanup.push(() => prisma.order.delete({ where: { id: order.id } }));
    expect(typeof order.totalAmount).toBe('number');
    expect(typeof order.commission).toBe('number');
    expect(order.totalAmount - order.commission).toBe(35);
  });

  it('Product.price', async () => {
    const product = await prisma.product.create({ data: { name: '[TEST] DATA-01', slug: `test-data01-prod-${Date.now()}`, price: 25 } });
    cleanup.push(() => prisma.product.delete({ where: { id: product.id } }));
    expect(typeof product.price).toBe('number');
    expect(product.price).toBe(25);
  });

  it('ShopOrder.totalAmount y ShopOrderItem.unitPrice', async () => {
    const product = await prisma.product.create({ data: { name: '[TEST] DATA-01', slug: `test-data01-prod2-${Date.now()}`, price: 20 } });
    cleanup.push(() => prisma.product.delete({ where: { id: product.id } }));
    const order = await prisma.shopOrder.create({
      data: {
        buyerName: 'x', buyerEmail: 'x@x.com', shippingAddress: 'x', shippingCity: 'x', shippingZip: '00000',
        totalAmount: 20, status: 'PAID',
        items: { create: { productId: product.id, quantity: 1, unitPrice: 20 } },
      },
      include: { items: true },
    });
    cleanup.push(() => prisma.shopOrderItem.deleteMany({ where: { shopOrderId: order.id } }).then(() => prisma.shopOrder.delete({ where: { id: order.id } })));
    expect(typeof order.totalAmount).toBe('number');
    expect(typeof order.items[0].unitPrice).toBe('number');
  });

  it('Articulo.ivaPercent, PrecioArticulo.precioSinIva/descuentoPercent', async () => {
    const proveedor = await prisma.proveedor.create({ data: { nombre: '[TEST] DATA-01' } });
    cleanup.push(() => prisma.proveedor.delete({ where: { id: proveedor.id } }));
    const articulo = await prisma.articulo.create({ data: { nombre: '[TEST] DATA-01', categoria: 'x', formato: 'x', ivaPercent: 21 } });
    cleanup.push(() => prisma.articulo.delete({ where: { id: articulo.id } }));
    const precio = await prisma.precioArticulo.create({ data: { articuloId: articulo.id, proveedorId: proveedor.id, precioSinIva: 0.55, descuentoPercent: 5, formatoVenta: 'x' } });
    cleanup.push(() => prisma.precioArticulo.delete({ where: { id: precio.id } }));
    expect(typeof articulo.ivaPercent).toBe('number');
    expect(typeof precio.precioSinIva).toBe('number');
    expect(typeof precio.descuentoPercent).toBe('number');
  });

  it('LineaPedido.precioSinIva/descuentoPercent/ivaPercent y Gasto.importeSinIva/ivaPercent', async () => {
    const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] DATA-01', anio: 2099 } });
    cleanup.push(() => prisma.temporada.delete({ where: { id: temporada.id } }));
    const proveedor = await prisma.proveedor.create({ data: { nombre: '[TEST] DATA-01 b' } });
    cleanup.push(() => prisma.proveedor.delete({ where: { id: proveedor.id } }));
    const articulo = await prisma.articulo.create({ data: { nombre: '[TEST] DATA-01 b', categoria: 'x', formato: 'x', ivaPercent: 21 } });
    cleanup.push(() => prisma.articulo.delete({ where: { id: articulo.id } }));
    const pedido = await prisma.pedido.create({
      data: {
        temporadaId: temporada.id, proveedorId: proveedor.id,
        lineas: { create: { articuloId: articulo.id, cantidad: 10, precioSinIva: 0.55, descuentoPercent: 5, ivaPercent: 21 } },
      },
      include: { lineas: true },
    });
    cleanup.push(() => prisma.lineaPedido.deleteMany({ where: { pedidoId: pedido.id } }).then(() => prisma.pedido.delete({ where: { id: pedido.id } })));
    const gasto = await prisma.gasto.create({ data: { temporadaId: temporada.id, categoria: 'x', concepto: '[TEST] DATA-01', importeSinIva: 50, ivaPercent: 21 } });
    cleanup.push(() => prisma.gasto.delete({ where: { id: gasto.id } }));

    expect(typeof pedido.lineas[0].precioSinIva).toBe('number');
    expect(typeof pedido.lineas[0].descuentoPercent).toBe('number');
    expect(typeof pedido.lineas[0].ivaPercent).toBe('number');
    expect(typeof gasto.importeSinIva).toBe('number');
    expect(typeof gasto.ivaPercent).toBe('number');
  });

  it('los resultados de aggregate() (_sum) NO pasan por la extensión — siguen siendo Decimal (excepción documentada)', async () => {
    const event = await prisma.event.create({ data: { name: '[TEST] DATA-01', slug: `test-data01-agg-${Date.now()}`, venue: 'x', city: 'x', date: new Date() } });
    cleanup.push(() => prisma.event.delete({ where: { id: event.id } }));
    const order = await prisma.order.create({ data: { eventId: event.id, buyerName: 'x', buyerLastName: 'x', buyerEmail: 'x@x.com', totalAmount: 10, status: 'COMPLETED' } });
    cleanup.push(() => prisma.order.delete({ where: { id: order.id } }));

    const agg = await prisma.order.aggregate({ where: { id: order.id }, _sum: { totalAmount: true } });
    // No es un number — cualquier código nuevo que use _sum/_avg/groupBy sobre
    // estos 14 campos debe convertir explícitamente con Number(...)/.toNumber()
    // antes de aritmética o de un NextResponse.json (ver app/api/admin/stats
    // y app/api/admin/gastos/resumen para el patrón ya aplicado).
    expect(typeof agg._sum.totalAmount).toBe('object');
    expect(Number(agg._sum.totalAmount)).toBe(10);
  });
});
