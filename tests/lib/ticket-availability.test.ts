import { describe, expect, it } from 'vitest';
import { getEventAvailability } from '@/lib/ticket-availability';
import { toTemplateEvent, type EventInput } from '@/app/(public)/_home/event-view';

const tt = (price: number, maxQuantity: number, soldCount: number, isActive?: boolean) => ({ price, maxQuantity, soldCount, ...(isActive === undefined ? {} : { isActive }) });

describe('getEventAvailability — a partir de lo VENDIDO por tipo activo', () => {
  it('con plazas en algún tipo: normal, no agotado, «Desde» = el precio mínimo', () => {
    const a = getEventAvailability([tt(20, 100, 10), tt(12, 100, 10), tt(30, 100, 0)], 500);
    expect(a).toEqual({ level: 'normal', soldOut: false, fromPrice: 12 });
  });

  it('«Desde» es el mínimo de los tipos CON plazas, no el primero ni uno agotado', () => {
    const a = getEventAvailability([tt(25, 100, 40), tt(10, 50, 50), tt(18, 80, 5)], 500);
    expect(a.fromPrice).toBe(18);
    expect(a.soldOut).toBe(false);
  });

  it('agotado cuando todos los tipos activos están vendidos: sin «Desde»', () => {
    const a = getEventAvailability([tt(15, 100, 100), tt(20, 50, 50)], 500);
    expect(a).toEqual({ level: 'sold_out', soldOut: true, fromPrice: null });
  });

  it('un tipo inactivo no cuenta: ni sus plazas ni su precio', () => {
    expect(getEventAvailability([tt(15, 100, 100), tt(5, 100, 0, false)], 500).soldOut).toBe(true);
    expect(getEventAvailability([tt(15, 100, 10), tt(5, 100, 0, false)], 500).fromPrice).toBe(15);
  });

  it('sin tipos activos cuenta como agotado (nada que comprar), igual que la ficha', () => {
    expect(getEventAvailability([], 500).soldOut).toBe(true);
    expect(getEventAvailability(undefined, 500).soldOut).toBe(true);
    expect(getEventAvailability(null, 500).level).toBe('sold_out');
    expect(getEventAvailability([tt(5, 100, 0, false)], 500).soldOut).toBe(true);
  });

  it('alta demanda: quedan pocas (≤ 50 y ≤ 20 % de lo ofrecido) sumando todos los tipos', () => {
    expect(getEventAvailability([tt(15, 100, 90)], 500).level).toBe('high');
    expect(getEventAvailability([tt(15, 60, 55), tt(20, 40, 38)], 500).level).toBe('high'); // quedan 7 de 100
    expect(getEventAvailability([tt(15, 100, 79)], 500).level).toBe('normal'); // quedan 21 de 100 (> 20 %)
    expect(getEventAvailability([tt(15, 1000, 900)], 5000).level).toBe('normal'); // quedan 100 (> 50) aunque sean el 10 %
    expect(getEventAvailability([tt(15, 1000, 960)], 5000).level).toBe('high'); // quedan 40 (≤ 50) y son el 4 %
  });

  it('una entrada que queda es alta demanda; cero es agotado', () => {
    expect(getEventAvailability([tt(15, 100, 99)], 500)).toEqual({ level: 'high', soldOut: false, fromPrice: 15 });
    expect(getEventAvailability([tt(15, 100, 100)], 500).level).toBe('sold_out');
  });

  it('sobreventa (vendidas > tope) no da plazas negativas ni compensa otros tipos', () => {
    const a = getEventAvailability([tt(15, 100, 120), tt(20, 100, 100)], 500);
    expect(a.soldOut).toBe(true);
  });

  it('el aforo manda: tipos con plazas pero aforo ya vendido = agotado', () => {
    const a = getEventAvailability([tt(15, 300, 100), tt(20, 300, 100)], 200);
    expect(a).toEqual({ level: 'sold_out', soldOut: true, fromPrice: null });
  });

  it('el aforo también acota las plazas que quedan para la alta demanda', () => {
    // Tipos con 400 libres, pero el aforo (500) solo deja 30 de 500: alta demanda.
    expect(getEventAvailability([tt(15, 500, 470)], 500).level).toBe('high');
    expect(getEventAvailability([tt(15, 1000, 470)], 500).level).toBe('high');
    // Aforo 0 o ausente = sin límite de aforo, solo cuentan los tipos.
    expect(getEventAvailability([tt(15, 100, 10)], 0).level).toBe('normal');
    expect(getEventAvailability([tt(15, 100, 10)]).level).toBe('normal');
  });

  // H-078: las invitaciones no suben `soldCount` (no tienen tipo) pero SÍ ocupan aforo: el checkout cuenta las entradas emitidas y rechaza con
  // «Aforo completo». La ficha pública anunciaba plazas que no existían.
  it('con entradas emitidas (invitaciones incluidas), el aforo se mide contra ellas y no contra lo vendido por tipo', () => {
    // 100 vendidas por tipo + 100 invitaciones = 200 emitidas de un aforo de 200: agotado.
    expect(getEventAvailability([tt(15, 300, 100)], 200, 200)).toEqual({ level: 'sold_out', soldOut: true, fromPrice: null });
    // Sin pasar las emitidas (comportamiento anterior) se anunciaban 100 plazas que no existen.
    expect(getEventAvailability([tt(15, 300, 100)], 200).soldOut).toBe(false);
  });

  it('las emitidas también acotan la alta demanda', () => {
    expect(getEventAvailability([tt(15, 1000, 100)], 500, 470).level).toBe('high');
  });

  it('sin aforo, las emitidas no cambian nada', () => {
    expect(getEventAvailability([tt(15, 100, 10)], null, 9999).level).toBe('normal');
  });
});

const event =(over: Partial<EventInput> = {}): EventInput => ({
  id: 'e1',
  slug: 'noche',
  name: 'Noche',
  date: '2026-07-18T21:00:00Z',
  venue: 'Sala',
  city: 'Valencia',
  maxCapacity: 500,
  ticketTypes: [tt(15, 100, 10)],
  ...over,
});

describe('toTemplateEvent — estado de venta y «Desde» (todas las plantillas y el listado)', () => {
  it('«Desde» es el precio mínimo de los tipos con plazas, venga el tipo barato el primero o no', () => {
    expect(toTemplateEvent(event({ ticketTypes: [tt(25, 100, 0), tt(10, 100, 0), tt(18, 100, 0)] })).fromPrice).toBe(10);
    expect(toTemplateEvent(event({ ticketTypes: [tt(10, 100, 100), tt(18, 100, 0)] })).fromPrice).toBe(18);
  });

  it('el evento vendido por completo antes de la puerta se marca «Sin plazas online» y sin precio', () => {
    const e = toTemplateEvent(event({ ticketTypes: [tt(15, 100, 100), tt(20, 50, 50)] }));
    expect(e.status).toBe('Sin plazas online');
    expect(e.fromPrice).toBeNull();
  });

  it('quedan pocas entradas: «Alta demanda»', () => {
    expect(toTemplateEvent(event({ ticketTypes: [tt(15, 100, 92)] })).status).toBe('Alta demanda');
  });

  it('las entradas escaneadas en puerta (currentCount) no intervienen', () => {
    // Lo que antes marcaba agotado (puerta llena) ya no: hay entradas por vender.
    const conPuertaLlena = { ...event(), currentCount: 500 } as EventInput;
    expect(toTemplateEvent(conPuertaLlena).status).toBeNull();
    // Y al revés: vendido del todo y 0 escaneos = agotado.
    const vendidoSinEscaneos = { ...event({ ticketTypes: [tt(15, 100, 100)] }), currentCount: 0 } as EventInput;
    expect(toTemplateEvent(vendidoSinEscaneos).status).toBe('Sin plazas online');
  });

  it('la venta cerrada online manda sobre el agotado', () => {
    const e = toTemplateEvent(event({ onlineSalesClosed: true, onlineSalesClosedLabel: 'Solo en taquilla', ticketTypes: [tt(15, 100, 100)] }));
    expect(e.status).toBe('Solo en taquilla');
  });
});
