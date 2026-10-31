import { describe, it, expect, afterEach, vi } from 'vitest';
import { hasEventEnded, isEventTonight, pickDefaultActiveEventId, EVENT_GRACE_PERIOD_MS } from '@/lib/active-event';

// H-079: la noche cruza la medianoche. En invierno Madrid va una hora por delante de UTC (22:00 en Madrid = 21:00Z).
describe('la noche cruza la medianoche (H-079)', () => {
  afterEach(() => vi.useRealTimers());
  const at = (iso: string) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };
  const ayer = { id: 'ayer', date: '2027-01-15T21:00:00Z', status: 'PUBLISHED' }; // viernes 22:00 Madrid
  const hoy = { id: 'hoy', date: '2027-01-16T21:00:00Z', status: 'PUBLISHED' }; // sábado 22:00 Madrid

  it('a las 00:30 la noche que empezó a las 22:00 sigue «en marcha»', () => {
    at('2027-01-15T23:30:00Z'); // 00:30 del sábado en Madrid
    expect(isEventTonight(ayer.date)).toBe(true);
  });

  it('pasado el margen de gracia ya no lo está (04:30 Madrid)', () => {
    at('2027-01-16T03:30:00Z');
    expect(isEventTonight(ayer.date)).toBe(false);
  });

  it('a las 00:30, con otro evento el día siguiente, la puerta elige el que está en marcha, no el de «hoy»', () => {
    at('2027-01-15T23:30:00Z');
    expect(pickDefaultActiveEventId([hoy, ayer])).toBe('ayer');
  });

  it('a mediodía, con el de anoche ya terminado, elige el de esta noche', () => {
    at('2027-01-16T11:00:00Z'); // 12:00 Madrid
    expect(pickDefaultActiveEventId([ayer, hoy])).toBe('hoy');
  });

  it('con dos en marcha a la vez, el que empezó antes (mismo criterio de siempre)', () => {
    at('2027-01-15T23:00:00Z');
    const a = { id: 'a', date: '2027-01-15T19:00:00Z', status: 'PUBLISHED' };
    const b = { id: 'b', date: '2027-01-15T21:00:00Z', status: 'PUBLISHED' };
    expect(pickDefaultActiveEventId([b, a])).toBe('a');
  });

  describe('hasEventEnded con la hora de fin', () => {
    const tarde = '2027-01-15T15:00:00Z'; // 16:00 Madrid
    it('un evento 16:00–04:00 sigue en venta pasadas las 22:00 (inicio + 6 h)', () => {
      at('2027-01-15T22:30:00Z'); // 23:30 Madrid
      expect(hasEventEnded(tarde)).toBe(true); // sin hora de fin: comportamiento de siempre
      expect(hasEventEnded(tarde, '04:00')).toBe(false);
    });

    it('y termina a la hora de fin (04:30 Madrid)', () => {
      at('2027-01-16T03:30:00Z');
      expect(hasEventEnded(tarde, '04:00')).toBe(true);
    });

    it('una hora de fin el mismo día también cuenta (16:00–23:00)', () => {
      at('2027-01-15T21:30:00Z'); // 22:30 Madrid: dentro del margen de 6 h y de la hora de fin
      expect(hasEventEnded(tarde, '23:00')).toBe(false);
      at('2027-01-15T22:30:00Z'); // 23:30 Madrid: pasada la hora de fin Y el margen
      expect(hasEventEnded(tarde, '23:00')).toBe(true);
    });

    it('una hora de fin ilegible o vacía se ignora', () => {
      at('2027-01-15T22:30:00Z');
      for (const bad of ['', null, undefined, 'tarde', '25:99', '4']) expect(hasEventEnded(tarde, bad as string | null | undefined), String(bad)).toBe(true);
    });

    it('la hora de fin nunca acorta el margen de gracia', () => {
      at('2027-01-15T19:00:00Z'); // 20:00 Madrid, 4 h tras el inicio
      expect(hasEventEnded(tarde, '17:00')).toBe(false);
    });
  });
});

describe('hasEventEnded', () => {
  // AUDIT: un evento PUBLISHED con fecha ya pasada se seguía anunciando y
  // vendiendo indefinidamente en la web pública — no había ningún corte por
  // fecha. Severidad: Alto.
  it('un evento de hace más de un año se considera finalizado', () => {
    const haceUnAño = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    expect(hasEventEnded(haceUnAño)).toBe(true);
  });

  it('un evento futuro no se considera finalizado', () => {
    const enUnaSemana = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(hasEventEnded(enUnaSemana)).toBe(false);
  });

  it('respeta el margen de gracia nocturno mientras el evento está "esta noche"', () => {
    const haceCincoHoras = new Date(Date.now() - 5 * 60 * 60 * 1000);
    expect(hasEventEnded(haceCincoHoras)).toBe(false);
  });

  it('se considera finalizado justo al superar el margen de gracia', () => {
    const justoFueraDelMargen = new Date(Date.now() - EVENT_GRACE_PERIOD_MS - 60 * 1000);
    expect(hasEventEnded(justoFueraDelMargen)).toBe(true);
  });

  it('devuelve false para fechas nulas o inválidas', () => {
    expect(hasEventEnded(null)).toBe(false);
    expect(hasEventEnded(undefined)).toBe(false);
    expect(hasEventEnded('fecha-no-valida')).toBe(false);
  });
});
