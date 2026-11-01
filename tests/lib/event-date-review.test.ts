import { describe, expect, it } from 'vitest';
import { eventsNeedingDateReview, intendedDateOfLegacyEvent } from '@/lib/event-date-review';
import { formatMadridLocal } from '@/lib/event-time';

/* H-073: los eventos creados a mano ANTES del arreglo de la zona horaria (P0-02) guardaron la hora del formulario como si fuera UTC: «22:30» quedó como
 * 22:30Z, que la web, el email, el PDF y Wallet (en Madrid) enseñan como 23:30 (invierno) o 00:30 del día siguiente (verano). No hay forma de saber CUÁLES lo
 * están (el instante guardado es válido), así que el sistema solo los LISTA (solo lectura) para que el dueño los revise a mano con la fecha en que se desplegó
 * el arreglo. Este módulo es la parte pura: qué eventos listar y qué fecha pretendía quien lo creó. */

const NOW = new Date('2026-10-31T12:00:00Z');
const ev = (over: Partial<Parameters<typeof eventsNeedingDateReview>[0][number]> = {}) => ({
  id: 'e1',
  name: 'Fiesta',
  slug: 'fiesta',
  date: new Date('2026-11-07T22:30:00Z'),
  status: 'PUBLISHED',
  createdAt: new Date('2026-09-01T10:00:00Z'),
  completedOrders: 0,
  ...over,
});
const CUTOFF = new Date('2026-10-15T00:00:00Z');

describe('intendedDateOfLegacyEvent', () => {
  it('invierno: lo guardado como 22:30Z es lo que en Madrid se ve como 23:30; lo que se quiso era 22:30 de Madrid (21:30Z)', () => {
    const saved = new Date('2026-11-07T22:30:00Z');
    expect(formatMadridLocal(saved)).toBe('2026-11-07T23:30');
    const intended = intendedDateOfLegacyEvent(saved)!;
    expect(intended.toISOString()).toBe('2026-11-07T21:30:00.000Z');
    expect(formatMadridLocal(intended)).toBe('2026-11-07T22:30');
  });

  it('verano: lo guardado como 23:30Z se ve como 01:30 del día siguiente; lo que se quiso era 23:30 de Madrid (21:30Z)', () => {
    const saved = new Date('2026-07-10T23:30:00Z');
    expect(formatMadridLocal(saved)).toBe('2026-07-11T01:30');
    const intended = intendedDateOfLegacyEvent(saved)!;
    expect(formatMadridLocal(intended)).toBe('2026-07-10T23:30');
  });
});

describe('eventsNeedingDateReview', () => {
  it('lista los creados antes de la fecha del arreglo, con fecha futura y sin cancelar ni terminar', () => {
    const list = eventsNeedingDateReview([ev()], { createdBefore: CUTOFF, now: NOW });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'e1', savedLocal: '2026-11-07T23:30', intendedLocal: '2026-11-07T22:30', completedOrders: 0 });
  });

  it('no lista los creados después del arreglo (ya guardan la hora de Madrid), ni los pasados, cancelados o terminados', () => {
    const list = eventsNeedingDateReview(
      [
        ev({ id: 'nuevo', createdAt: new Date('2026-10-20T10:00:00Z') }),
        ev({ id: 'pasado', date: new Date('2026-10-01T22:30:00Z') }),
        ev({ id: 'cancelado', status: 'CANCELLED' }),
        ev({ id: 'terminado', status: 'FINISHED' }),
        ev({ id: 'borrador', status: 'DRAFT' }),
      ],
      { createdBefore: CUTOFF, now: NOW }
    );
    expect(list.map((e) => e.id)).toEqual(['borrador']);
  });

  it('avisa de cuántos compradores tiene: corregir la fecha de un evento con pedidos pide decidir si avisarles', () => {
    const [row] = eventsNeedingDateReview([ev({ completedOrders: 12 })], { createdBefore: CUTOFF, now: NOW });
    expect(row.completedOrders).toBe(12);
    expect(row.advice).toMatch(/12/);
    expect(row.advice).toMatch(/avisar/i);
  });

  it('sin compradores, la corrección es directa', () => {
    const [row] = eventsNeedingDateReview([ev({ completedOrders: 0 })], { createdBefore: CUTOFF, now: NOW });
    expect(row.advice).not.toMatch(/avisar/i);
  });

  it('ordena por fecha del evento (el más próximo primero)', () => {
    const list = eventsNeedingDateReview(
      [ev({ id: 'tarde', date: new Date('2026-12-20T22:00:00Z') }), ev({ id: 'pronto', date: new Date('2026-11-02T22:00:00Z') })],
      { createdBefore: CUTOFF, now: NOW }
    );
    expect(list.map((e) => e.id)).toEqual(['pronto', 'tarde']);
  });
});
