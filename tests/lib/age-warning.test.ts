import { describe, it, expect } from 'vitest';
import { getEventAgeWarningMessage } from '@/lib/age-warning';

describe('getEventAgeWarningMessage', () => {
  it('devuelve null si el aviso no está activado para el evento', () => {
    expect(getEventAgeWarningMessage({ ageWarningEnabled: false, ageWarningMessage: 'Texto', minAge: 18 })).toBeNull();
  });

  it('genera un mensaje por defecto a partir de la edad mínima si no hay texto propio', () => {
    const message = getEventAgeWarningMessage({ ageWarningEnabled: true, ageWarningMessage: null, minAge: 21 });
    expect(message).toContain('21 años');
  });

  it('usa 18 como edad mínima por defecto si el evento no la tiene fijada', () => {
    const message = getEventAgeWarningMessage({ ageWarningEnabled: true, ageWarningMessage: null, minAge: null });
    expect(message).toContain('18 años');
  });

  it('usa el mensaje personalizado del evento cuando está definido, ignorando el genérico', () => {
    const message = getEventAgeWarningMessage({
      ageWarningEnabled: true,
      ageWarningMessage: 'Aviso a medida para este evento.',
      minAge: 18,
    });
    expect(message).toBe('Aviso a medida para este evento.');
  });

  // AUDIT: un mensaje personalizado con solo espacios no debe colarse como
  // aviso "vacío" en vez de caer al genérico por edad mínima.
  it('trata un mensaje personalizado en blanco como si no existiera', () => {
    const message = getEventAgeWarningMessage({ ageWarningEnabled: true, ageWarningMessage: '   ', minAge: 18 });
    expect(message).toContain('18 años');
  });
});
