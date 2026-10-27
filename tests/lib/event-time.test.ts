import { afterEach, describe, expect, it } from 'vitest';
import { formatMadridLocal, formatMadridTime, parseEventDateInput, parseMadridLocal } from '@/lib/event-time';

const iso = (d: Date | null) => d?.toISOString() ?? null;

// Los tests corren con TZ=UTC (como Vercel); los que lo piden cambian la zona DEL PROCESO para demostrar que el resultado no depende de ella.
const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('parseMadridLocal — de «datetime-local» en hora de Madrid a instante', () => {
  it('invierno (UTC+1): 23:30 de Madrid son las 22:30Z', () => {
    expect(iso(parseMadridLocal('2026-12-31T23:30'))).toBe('2026-12-31T22:30:00.000Z');
  });

  it('verano (UTC+2): 23:30 de Madrid son las 21:30Z', () => {
    expect(iso(parseMadridLocal('2026-07-15T23:30'))).toBe('2026-07-15T21:30:00.000Z');
  });

  it('00:30 de Madrid cae en el día anterior en UTC, en invierno y en verano', () => {
    expect(iso(parseMadridLocal('2026-01-10T00:30'))).toBe('2026-01-09T23:30:00.000Z');
    expect(iso(parseMadridLocal('2026-07-16T00:30'))).toBe('2026-07-15T22:30:00.000Z');
  });

  it('acepta segundos, milisegundos, espacio como separador y solo la fecha (00:00 de Madrid)', () => {
    expect(iso(parseMadridLocal('2026-07-15T23:30:15'))).toBe('2026-07-15T21:30:15.000Z');
    expect(iso(parseMadridLocal('2026-07-15T23:30:15.250'))).toBe('2026-07-15T21:30:15.250Z');
    expect(iso(parseMadridLocal('2026-07-15 23:30'))).toBe('2026-07-15T21:30:00.000Z');
    expect(iso(parseMadridLocal('2026-07-15'))).toBe('2026-07-14T22:00:00.000Z');
  });

  it('rechaza lo que no es una fecha válida', () => {
    for (const bad of ['', 'hola', '2026-02-30T10:00', '2026-13-01T10:00', '2026-07-15T24:00', '2026-07-15T10:60', '15/07/2026 23:30', '2026-07-15T23:30Z']) {
      expect(parseMadridLocal(bad), bad).toBeNull();
    }
  });

  describe('cambio de hora de marzo (domingo 2026-03-29: a las 02:00 pasan a ser las 03:00)', () => {
    it('antes del salto es UTC+1 y después UTC+2', () => {
      expect(iso(parseMadridLocal('2026-03-29T01:59'))).toBe('2026-03-29T00:59:00.000Z');
      expect(iso(parseMadridLocal('2026-03-29T03:00'))).toBe('2026-03-29T01:00:00.000Z');
      expect(iso(parseMadridLocal('2026-03-28T23:30'))).toBe('2026-03-28T22:30:00.000Z');
      expect(iso(parseMadridLocal('2026-03-29T23:30'))).toBe('2026-03-29T21:30:00.000Z');
    });

    it('una hora inexistente (02:30) se corre hacia delante: 03:30 de Madrid', () => {
      const d = parseMadridLocal('2026-03-29T02:30')!;
      expect(d.toISOString()).toBe('2026-03-29T01:30:00.000Z');
      expect(formatMadridLocal(d)).toBe('2026-03-29T03:30');
    });
  });

  describe('cambio de hora de octubre (domingo 2026-10-25: a las 03:00 vuelven a ser las 02:00)', () => {
    it('antes del salto es UTC+2 y después UTC+1', () => {
      expect(iso(parseMadridLocal('2026-10-25T01:59'))).toBe('2026-10-24T23:59:00.000Z');
      expect(iso(parseMadridLocal('2026-10-25T03:00'))).toBe('2026-10-25T02:00:00.000Z');
      expect(iso(parseMadridLocal('2026-10-24T23:30'))).toBe('2026-10-24T21:30:00.000Z');
      expect(iso(parseMadridLocal('2026-10-25T23:30'))).toBe('2026-10-25T22:30:00.000Z');
    });

    it('una hora repetida (02:30 ocurre dos veces) se resuelve a la primera, la de verano', () => {
      const d = parseMadridLocal('2026-10-25T02:30')!;
      expect(d.toISOString()).toBe('2026-10-25T00:30:00.000Z');
      expect(formatMadridLocal(d)).toBe('2026-10-25T02:30');
      // La segunda 02:30 (UTC+1) existe como instante y también se muestra como 02:30.
      expect(formatMadridLocal(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-25T02:30');
    });
  });
});

describe('formatMadridLocal — de instante a «datetime-local» en hora de Madrid', () => {
  it('un evento sembrado a 21:00Z (verano) se ve a las 23:00; a 22:00Z (invierno) también', () => {
    expect(formatMadridLocal(new Date('2026-07-18T21:00:00Z'))).toBe('2026-07-18T23:00');
    expect(formatMadridLocal(new Date('2026-12-05T22:00:00Z'))).toBe('2026-12-05T23:00');
  });

  it('el instante de las 23:30 UTC ya es el día siguiente en Madrid', () => {
    expect(formatMadridLocal(new Date('2026-11-14T23:30:00Z'))).toBe('2026-11-15T00:30');
  });

  it('acepta cadenas ISO y marcas de tiempo; vacío o inválido da cadena vacía', () => {
    expect(formatMadridLocal('2026-07-18T21:00:00.000Z')).toBe('2026-07-18T23:00');
    expect(formatMadridLocal(Date.UTC(2026, 6, 18, 21, 0))).toBe('2026-07-18T23:00');
    for (const empty of [null, undefined, '', 'no es fecha', new Date(NaN)]) expect(formatMadridLocal(empty)).toBe('');
  });

  it('formatMadridTime da HH:mm de Madrid (hora de entrada en puerta)', () => {
    expect(formatMadridTime(new Date('2026-07-18T21:35:00Z'))).toBe('23:35');
    expect(formatMadridTime('2026-12-05T22:35:00Z')).toBe('23:35');
    expect(formatMadridTime(null)).toBe('N/A');
    expect(formatMadridTime(undefined)).toBe('N/A');
  });
});

describe('ida y vuelta', () => {
  it('formatMadridLocal(parseMadridLocal(x)) === x para cada media hora de 2026 salvo la hora inexistente de marzo', () => {
    const gap = new Set(['2026-03-29T02:00', '2026-03-29T02:30']);
    let checked = 0;
    for (let t = Date.UTC(2025, 11, 31, 12); t < Date.UTC(2027, 0, 1, 12); t += 30 * 60 * 1000) {
      const local = formatMadridLocal(new Date(t));
      if (!local.startsWith('2026') || gap.has(local)) continue;
      const back = parseMadridLocal(local);
      expect(formatMadridLocal(back), local).toBe(local);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(17000);
  });

  it('y al revés, para todos los instantes de 2026 distintos de la segunda hora de octubre (que es indistinguible de la primera)', () => {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 30 * 60 * 1000) {
      const second = t >= Date.UTC(2026, 9, 25, 1) && t < Date.UTC(2026, 9, 25, 2); // segunda pasada 02:00-02:59 (01:00Z-01:59Z)
      if (second) continue;
      expect(parseMadridLocal(formatMadridLocal(new Date(t)))!.getTime(), new Date(t).toISOString()).toBe(t);
    }
  });

  it('editar un evento sembrado sin tocar la hora no la cambia (carga 23:00, guarda 23:00 → 21:00Z)', () => {
    const seeded = new Date('2026-07-18T21:00:00Z');
    const formValue = formatMadridLocal(seeded);
    expect(formValue).toBe('2026-07-18T23:00');
    expect(iso(parseEventDateInput(formValue))).toBe(seeded.toISOString());
  });
});

describe('parseEventDateInput — lo que recibe el servidor', () => {
  it('sin designador de zona es hora de Madrid (lo que envía el formulario)', () => {
    expect(iso(parseEventDateInput('2026-07-18T23:00'))).toBe('2026-07-18T21:00:00.000Z');
    expect(iso(parseEventDateInput('2026-12-31T23:30'))).toBe('2026-12-31T22:30:00.000Z');
    expect(iso(parseEventDateInput('  2026-12-31T23:30  '))).toBe('2026-12-31T22:30:00.000Z');
  });

  it('con Z se respeta (scripts, seeds, otros llamadores)', () => {
    expect(iso(parseEventDateInput('2026-07-18T21:00:00Z'))).toBe('2026-07-18T21:00:00.000Z');
    expect(iso(parseEventDateInput('2026-07-18T21:00:00.000Z'))).toBe('2026-07-18T21:00:00.000Z');
    expect(iso(parseEventDateInput('2026-07-18T21:00Z'))).toBe('2026-07-18T21:00:00.000Z');
  });

  it('con offset se respeta, sea o no el de Madrid', () => {
    expect(iso(parseEventDateInput('2026-07-18T23:00:00+02:00'))).toBe('2026-07-18T21:00:00.000Z');
    expect(iso(parseEventDateInput('2026-07-18T23:00:00+0200'))).toBe('2026-07-18T21:00:00.000Z');
    expect(iso(parseEventDateInput('2026-07-18T23:00+02'))).toBe('2026-07-18T21:00:00.000Z');
    expect(iso(parseEventDateInput('2026-07-18T23:00:00-05:00'))).toBe('2026-07-19T04:00:00.000Z');
    // Un offset que no es el de Madrid en esa fecha tampoco se «corrige»: el llamador sabe lo que manda.
    expect(iso(parseEventDateInput('2026-07-18T23:00:00+01:00'))).toBe('2026-07-18T22:00:00.000Z');
  });

  it('la fecha sola vale 00:00 de Madrid; lo inválido da null', () => {
    expect(iso(parseEventDateInput('2026-07-18'))).toBe('2026-07-17T22:00:00.000Z');
    for (const bad of ['', '   ', 'mañana', '2026-02-30T10:00', '2026-07-18T25:00:00Z', '2026-07-18T10:00:00+99:99x']) {
      expect(parseEventDateInput(bad), bad).toBeNull();
    }
  });
});

describe('independiente de la zona horaria del proceso (Vercel en UTC, un portátil en Madrid, un servidor en otra parte)', () => {
  const cases: [string, string][] = [
    ['2026-12-31T23:30', '2026-12-31T22:30:00.000Z'],
    ['2026-07-16T00:30', '2026-07-15T22:30:00.000Z'],
    ['2026-03-29T02:30', '2026-03-29T01:30:00.000Z'],
    ['2026-10-25T02:30', '2026-10-25T00:30:00.000Z'],
    ['2026-10-25T03:00', '2026-10-25T02:00:00.000Z'],
  ];

  for (const tz of ['UTC', 'Europe/Madrid', 'America/New_York', 'Asia/Tokyo', 'Pacific/Auckland']) {
    it(`TZ=${tz}`, () => {
      process.env.TZ = tz;
      // Comprobación de que el cambio de zona del proceso ha surtido efecto: `new Date(texto sin zona)` sí depende de ella.
      const naive = new Date('2026-07-15T23:30').toISOString();
      if (tz === 'UTC') expect(naive).toBe('2026-07-15T23:30:00.000Z');
      if (tz === 'Asia/Tokyo') expect(naive).toBe('2026-07-15T14:30:00.000Z');

      for (const [local, utc] of cases) {
        expect(iso(parseMadridLocal(local)), local).toBe(utc);
        expect(iso(parseEventDateInput(local)), local).toBe(utc);
        expect(formatMadridLocal(new Date(utc))).toBe(local === '2026-03-29T02:30' ? '2026-03-29T03:30' : local);
      }
      expect(formatMadridLocal(new Date('2026-07-18T21:00:00Z'))).toBe('2026-07-18T23:00');
      expect(formatMadridTime(new Date('2026-07-18T21:35:00Z'))).toBe('23:35');
    });
  }
});
