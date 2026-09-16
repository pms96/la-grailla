import { describe, it, expect } from 'vitest';
import { parseSponsorTiers, DEFAULT_SPONSOR_TIERS } from '@/lib/sponsor-tiers';

describe('parseSponsorTiers', () => {
  it('devuelve los tipos por defecto si no hay nada guardado', () => {
    expect(parseSponsorTiers(null)).toEqual(DEFAULT_SPONSOR_TIERS);
    expect(parseSponsorTiers(undefined)).toEqual(DEFAULT_SPONSOR_TIERS);
    expect(parseSponsorTiers('')).toEqual(DEFAULT_SPONSOR_TIERS);
  });

  it('devuelve los tipos por defecto si el JSON guardado está corrupto', () => {
    expect(parseSponsorTiers('{esto no es json')).toEqual(DEFAULT_SPONSOR_TIERS);
  });

  it('devuelve los tipos por defecto si el JSON guardado no es una lista', () => {
    expect(parseSponsorTiers(JSON.stringify({ foo: 'bar' }))).toEqual(DEFAULT_SPONSOR_TIERS);
  });

  it('parsea una lista de tipos personalizada guardada desde Configuración', () => {
    const custom = [
      { value: 'oro', label: 'Patrocinador Oro', priceLabel: '500€' },
      { value: 'plata', label: 'Patrocinador Plata', priceLabel: '200€' },
    ];
    expect(parseSponsorTiers(JSON.stringify(custom))).toEqual(custom);
  });

  // AUDIT: una fila corrupta o incompleta (p.ej. un admin que edita el JSON a
  // mano en devtools) no debe tumbar el select entero del formulario público.
  it('descarta entradas inválidas y conserva las válidas', () => {
    const mixed = [
      { value: 'oro', label: 'Oro', priceLabel: '500€' },
      { value: '', label: 'Sin valor', priceLabel: '0€' },
      { value: 'roto' },
      null,
      'no es un objeto',
    ];
    expect(parseSponsorTiers(JSON.stringify(mixed))).toEqual([{ value: 'oro', label: 'Oro', priceLabel: '500€' }]);
  });

  it('devuelve los tipos por defecto si tras filtrar no queda ninguna entrada válida', () => {
    expect(parseSponsorTiers(JSON.stringify([{ value: '' }, null]))).toEqual(DEFAULT_SPONSOR_TIERS);
  });
});
