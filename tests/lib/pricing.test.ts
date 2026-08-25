import { describe, it, expect } from 'vitest';
import { calculateCommission } from '@/lib/pricing';

describe('calculateCommission', () => {
  it('calcula el porcentaje sobre el subtotal', () => {
    expect(calculateCommission(40, 5)).toBe(2);
    expect(calculateCommission(100, 10)).toBe(10);
  });

  it('devuelve 0 cuando no hay comisión configurada', () => {
    expect(calculateCommission(50, 0)).toBe(0);
  });

  it('devuelve 0 sobre un subtotal de 0 (carrito vacío)', () => {
    expect(calculateCommission(0, 5)).toBe(0);
  });

  it('soporta porcentajes con decimales', () => {
    expect(calculateCommission(20, 2.5)).toBeCloseTo(0.5);
  });
});
