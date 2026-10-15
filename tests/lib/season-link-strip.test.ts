import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/modules/runtime', () => ({ isModuleEnabled: () => state.on }));

import { withoutSeasonLink } from '@/lib/modules/season-link';

const row = { id: 'e1', name: 'Evento', temporadaId: 't1', temporada: { id: 't1', nombre: '2026' }, date: new Date('2026-12-01T20:00:00Z'), tickets: [{ id: 'k1', temporadaId: 't1' }] };

describe('withoutSeasonLink', () => {
  it('sin Contabilidad quita temporadaId y temporada, también anidados, y conserva fechas y el resto', () => {
    state.on = false;
    const out = withoutSeasonLink(row);
    expect(out).toEqual({ id: 'e1', name: 'Evento', date: row.date, tickets: [{ id: 'k1' }] });
    expect(out.date).toBeInstanceOf(Date);
  });

  it('con Contabilidad devuelve lo mismo que recibe', () => {
    state.on = true;
    expect(withoutSeasonLink(row)).toBe(row);
  });

  it('funciona con listas y no rompe valores que no son objetos', () => {
    state.on = false;
    expect(withoutSeasonLink([row, null, 3, 'x'])).toEqual([{ id: 'e1', name: 'Evento', date: row.date, tickets: [{ id: 'k1' }] }, null, 3, 'x']);
  });
});
