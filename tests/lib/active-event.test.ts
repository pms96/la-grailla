import { describe, it, expect } from 'vitest';
import { hasEventEnded, EVENT_GRACE_PERIOD_MS } from '@/lib/active-event';

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
