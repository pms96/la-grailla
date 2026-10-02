import { describe, it, expect } from 'vitest';
import { addDays, buildVentasPorDia, classifyOrder, madridDayKey, madridDayStart } from '@/lib/ventas-por-dia';

describe('classifyOrder', () => {
  it('separa online, taquilla tarjeta, taquilla efectivo y gratis', () => {
    expect(classifyOrder({ channel: 'ONLINE', paymentMethod: 'CARD' })).toBe('online');
    expect(classifyOrder({ channel: 'TAQUILLA', paymentMethod: 'CARD' })).toBe('taquillaTarjeta');
    expect(classifyOrder({ channel: 'TAQUILLA', paymentMethod: 'CASH' })).toBe('taquillaEfectivo');
    expect(classifyOrder({ channel: 'TAQUILLA', paymentMethod: 'FREE' })).toBe('gratis');
    expect(classifyOrder({ channel: 'INVITACION', paymentMethod: 'FREE' })).toBe('gratis');
  });
});

describe('día en hora de Madrid', () => {
  // AUDIT: agrupar por UTC metía las ventas de madrugada en el día anterior.
  it('una venta a las 00:30 en Madrid (verano) cuenta en el día nuevo', () => {
    expect(madridDayKey(new Date('2026-09-25T22:30:00Z'))).toBe('2026-09-26');
    expect(madridDayKey(new Date('2026-09-25T21:59:00Z'))).toBe('2026-09-25');
  });

  it('el inicio del día respeta el horario de verano e invierno', () => {
    expect(madridDayStart('2026-09-26').toISOString()).toBe('2026-09-25T22:00:00.000Z');
    expect(madridDayStart('2026-12-15').toISOString()).toBe('2026-12-14T23:00:00.000Z');
    // Día del cambio a horario de invierno (25 de octubre de 2026): 25 horas.
    expect(madridDayStart('2026-10-26').getTime() - madridDayStart('2026-10-25').getTime()).toBe(25 * 3600 * 1000);
  });

  it('addDays suma días naturales', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('buildVentasPorDia', () => {
  const orders = [
    { createdAt: new Date('2026-09-25T18:00:00Z'), totalAmount: 20, channel: 'ONLINE', paymentMethod: 'CARD', tickets: 2 },
    { createdAt: new Date('2026-09-25T19:00:00Z'), totalAmount: 30, channel: 'TAQUILLA', paymentMethod: 'CASH', tickets: 3 },
    { createdAt: new Date('2026-09-25T20:00:00Z'), totalAmount: 10, channel: 'TAQUILLA', paymentMethod: 'CARD', tickets: 1 },
    { createdAt: new Date('2026-09-25T22:30:00Z'), totalAmount: 15, channel: 'TAQUILLA', paymentMethod: 'CASH', tickets: 1 },
    { createdAt: new Date('2026-09-26T10:00:00Z'), totalAmount: 0, channel: 'INVITACION', paymentMethod: 'FREE', tickets: 2 },
  ];

  it('reparte cada pedido en su canal y día, con totales', () => {
    const { dias, totales } = buildVentasPorDia(orders, null);
    expect(dias.map((d) => d.fecha)).toEqual(['2026-09-25', '2026-09-26']);

    const d1 = dias[0];
    expect(d1.online).toEqual({ importe: 20, entradas: 2, pedidos: 1 });
    expect(d1.taquillaEfectivo).toEqual({ importe: 30, entradas: 3, pedidos: 1 });
    expect(d1.taquillaTarjeta).toEqual({ importe: 10, entradas: 1, pedidos: 1 });
    expect(d1.total).toEqual({ importe: 60, entradas: 6, pedidos: 3 });

    // La venta de las 22:30Z son las 00:30 del 26 en Madrid.
    expect(dias[1].taquillaEfectivo).toEqual({ importe: 15, entradas: 1, pedidos: 1 });
    expect(dias[1].gratis).toEqual({ importe: 0, entradas: 2, pedidos: 1 });

    expect(totales.total).toEqual({ importe: 75, entradas: 9, pedidos: 5 });
    expect(totales.taquillaEfectivo.importe).toBe(45);
  });

  it('compara la caja "Entradas" con el efectivo de taquilla solo en los días con caja', () => {
    const { dias, totales } = buildVentasPorDia(orders, [
      { fecha: new Date('2026-09-25'), concepto: 'Entradas', importe: 25 },
      { fecha: new Date('2026-09-25'), concepto: 'Barra', importe: 999 },
    ]);
    expect(dias[0].cajaEntradas).toBe(25);
    expect(dias[0].diferenciaCaja).toBe(-5);
    expect(dias[1].cajaEntradas).toBeNull();
    expect(dias[1].diferenciaCaja).toBeNull();
    expect(totales.cajaEntradas).toBe(25);
    expect(totales.diferenciaCaja).toBe(-5);
  });

  it('muestra un día con caja aunque no haya ventas', () => {
    const { dias } = buildVentasPorDia([], [{ fecha: new Date('2026-09-27'), concepto: 'Entradas', importe: 40 }]);
    expect(dias).toHaveLength(1);
    expect(dias[0].diferenciaCaja).toBe(40);
  });

  it('sin ingresos (filtro por evento) no hay comparación', () => {
    const { dias, totales } = buildVentasPorDia(orders, null);
    expect(dias.every((d) => d.cajaEntradas === null)).toBe(true);
    expect(totales.diferenciaCaja).toBeNull();
  });
});
