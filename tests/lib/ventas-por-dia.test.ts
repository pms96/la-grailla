import { describe, it, expect } from 'vitest';
import { addDays, buildVentasPorDia, businessDayKey, businessDayStart, classifyOrder, madridDayKey, madridDayStart, parseJornadaCorte } from '@/lib/ventas-por-dia';

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

/* P1-15: la caja se anota por «noche» y las ventas se agrupaban por día natural: lo vendido a las 23:30 y a las 00:30 caía en dos días y el cuadre
 * salía descuadrado dos días seguidos, todas las noches. La jornada de negocio (con hora de corte) lo agrupa entero. */
describe('jornada de negocio (P1-15)', () => {
  it('parseJornadaCorte: solo un entero de 0 a 12; cualquier otra cosa es 0 (nunca mueve la caja por un valor roto)', () => {
    expect(parseJornadaCorte('6')).toBe(6);
    expect(parseJornadaCorte(' 12 ')).toBe(12);
    expect(parseJornadaCorte(0)).toBe(0);
    expect(parseJornadaCorte(6)).toBe(6);
    for (const bad of ['', 'x', '13', '-1', '6.5', '06h', null, undefined, NaN, 99, 6.5, {}]) expect(parseJornadaCorte(bad), String(bad)).toBe(0);
  });

  it('con corte 0 es el día natural de Madrid, igual que antes', () => {
    for (const iso of ['2026-10-31T22:30:00Z', '2026-10-31T23:30:00Z', '2026-12-15T10:00:00Z']) {
      expect(businessDayKey(new Date(iso), 0)).toBe(madridDayKey(new Date(iso)));
      expect(businessDayKey(new Date(iso))).toBe(madridDayKey(new Date(iso)));
    }
  });

  it('con corte a las 06:00, una noche de 23:30 a 00:30 es UNA jornada; la jornada cambia a las 06:00 en punto (hora de Madrid)', () => {
    // 31/10/2026 es sábado y Madrid está en horario de invierno (UTC+1).
    const key = (iso: string) => businessDayKey(new Date(iso), 6);
    expect(key('2026-10-31T22:30:00Z')).toBe('2026-10-31'); // sáb 23:30
    expect(key('2026-10-31T23:30:00Z')).toBe('2026-10-31'); // dom 00:30: la misma jornada
    expect(key('2026-11-01T04:59:00Z')).toBe('2026-10-31'); // dom 05:59
    expect(key('2026-11-01T05:00:00Z')).toBe('2026-11-01'); // dom 06:00: empieza la siguiente
    expect(key('2026-10-31T04:59:00Z')).toBe('2026-10-30'); // sáb 05:59 aún es la jornada del viernes
  });

  it('businessDayStart es la inversa EXACTA de businessDayKey, también en los días de cambio horario (23 y 25 h)', () => {
    const days = ['2026-03-28', '2026-03-29', '2026-03-30', '2026-09-26', '2026-10-24', '2026-10-25', '2026-10-26', '2026-12-31'];
    for (const day of days) {
      for (let cutoff = 0; cutoff <= 12; cutoff += 1) {
        const start = businessDayStart(day, cutoff);
        const next = businessDayStart(addDays(day, 1), cutoff);
        const label = `${day} corte ${cutoff}`;
        expect(businessDayKey(start, cutoff), label).toBe(day);
        expect(businessDayKey(new Date(start.getTime() - 1), cutoff), label).toBe(addDays(day, -1));
        expect(businessDayKey(new Date(next.getTime() - 1), cutoff), label).toBe(day);
        expect(businessDayKey(next, cutoff), label).toBe(addDays(day, 1));
      }
    }
  });

  it('con corte 0, businessDayStart coincide con el inicio del día de Madrid de siempre', () => {
    expect(businessDayStart('2026-09-26', 0).toISOString()).toBe(madridDayStart('2026-09-26').toISOString());
    expect(businessDayStart('2026-09-26', 6).toISOString()).toBe('2026-09-26T04:00:00.000Z'); // 06:00 en horario de verano (UTC+2)
  });

  describe('el cuadre de la noche (el escenario del anexo)', () => {
    // Sábado 31/10: la taquilla vende 600 € en efectivo, 400 antes de medianoche y 200 después; la caja de la noche se anota en el sábado.
    const order = (iso: string, totalAmount: number) => ({ createdAt: new Date(iso), totalAmount, channel: 'TAQUILLA', paymentMethod: 'CASH', tickets: 1 });
    const orders = [order('2026-10-31T21:30:00Z', 400), order('2026-10-31T23:30:00Z', 200)]; // 22:30 y 00:30 de Madrid
    const caja = [{ fecha: new Date('2026-10-31'), concepto: 'Entradas', importe: 600 }];

    it('SIN corte (como antes): se reparte en dos días y la diferencia sale +200 un día y sin caja el siguiente', () => {
      const { dias } = buildVentasPorDia(orders, caja);
      expect(dias.map((d) => d.fecha)).toEqual(['2026-10-31', '2026-11-01']);
      expect(dias[0].taquillaEfectivo.importe).toBe(400);
      expect(dias[0].diferenciaCaja).toBe(200);
      expect(dias[1].taquillaEfectivo.importe).toBe(200);
      expect(dias[1].diferenciaCaja).toBeNull();
    });

    it('CON corte a las 06:00: una sola jornada, 600 € de efectivo y la caja CUADRA', () => {
      const { dias, totales } = buildVentasPorDia(orders, caja, { cutoffHour: 6 });
      expect(dias.map((d) => d.fecha)).toEqual(['2026-10-31']);
      expect(dias[0].taquillaEfectivo.importe).toBe(600);
      expect(dias[0].cajaEntradas).toBe(600);
      expect(dias[0].diferenciaCaja).toBe(0);
      expect(totales.diferenciaCaja).toBe(0);
    });

    it('un corte inválido se trata como 0 (día natural)', () => {
      const bad = buildVentasPorDia(orders, caja, { cutoffHour: 99 });
      expect(bad.dias.map((d) => d.fecha)).toEqual(['2026-10-31', '2026-11-01']);
    });

    it('el corte no cambia ningún importe: solo reparte los mismos pedidos en jornadas distintas', () => {
      const natural = buildVentasPorDia(orders, caja).totales.total;
      const jornada = buildVentasPorDia(orders, caja, { cutoffHour: 6 }).totales.total;
      expect(jornada).toEqual(natural);
    });
  });
});
