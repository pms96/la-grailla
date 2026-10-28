import { describe, it, expect } from 'vitest';
import { calculateCommission, calculateCommissionCents, fromCents, parsePercentOr, roundMoney, sumMoney, toCents } from '@/lib/pricing';

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
    expect(calculateCommission(20, 2.5)).toBe(0.5);
  });
});

/* P1-07: el total se calcula en céntimos enteros y se redondea UNA vez. Antes, la comisión salía sin redondear y la pasarela (Math.round(x*100)) y la BD
 * (Decimal(10,2)) la redondeaban cada una a su manera: con el 1,5 % sobre 33 €, Stripe cobraba 33,49 y el pedido guardaba 33,50. */
describe('importes en céntimos (P1-07)', () => {
  it('el caso del informe: 1,5 % sobre 33 € son 0,50 € (la mitad hacia arriba) y el total 33,50 €', () => {
    expect(calculateCommissionCents(3300, 1.5)).toBe(50);
    expect(calculateCommission(33, 1.5)).toBe(0.5);
    expect(sumMoney(33, calculateCommission(33, 1.5))).toBe(33.5);
  });

  it('la comisión siempre es un número exacto de céntimos', () => {
    for (const [sub, pct] of [[16.5, 1.5], [9.99, 7.5], [0.5, 2.5], [1234.56, 3.3], [19.99 * 3, 4.75]] as const) {
      const c = calculateCommission(sub, pct);
      expect(toCents(c) / 100).toBe(c);
      expect(Number.isInteger(toCents(c))).toBe(true);
    }
  });

  it('barrido: lo que cobra la pasarela (céntimos) es EXACTAMENTE lo que guarda la BD, para miles de combinaciones de precio, cantidad y comisión', () => {
    let checked = 0;
    for (const price of [0.5, 1, 4.99, 9.99, 12.5, 16.5, 19.99, 23.45, 33.33, 49.9, 120]) {
      for (const qty of [1, 2, 3, 7, 10]) {
        for (let pct = 0.5; pct <= 7.5; pct += 0.1) {
          const percent = Math.round(pct * 10) / 10;
          const subtotalCents = toCents(price) * qty;
          const commissionCents = calculateCommissionCents(subtotalCents, percent);
          const total = fromCents(subtotalCents + commissionCents); // lo que se guarda y se manda a la pasarela
          const stripeCents = toCents(total); // lo que cobra Stripe
          const dbCents = Math.round(Number(total.toFixed(2)) * 100); // lo que guarda Decimal(10,2)
          expect(stripeCents).toBe(dbCents);
          expect(stripeCents).toBe(subtotalCents + commissionCents);
          expect(roundMoney(total)).toBe(total); // un float crudo a SumUp ya no puede llevar 3 decimales
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it('sin comisión, o sobre un subtotal 0, es 0 (y un porcentaje no válido no rompe nada)', () => {
    expect(calculateCommissionCents(5000, 0)).toBe(0);
    expect(calculateCommissionCents(0, 5)).toBe(0);
    expect(calculateCommissionCents(5000, -3)).toBe(0);
    expect(calculateCommissionCents(5000, Number.NaN)).toBe(0);
  });

  it('suma de importes sin error de coma flotante', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMoney(0.1, 0.2)).toBe(0.3);
    expect(sumMoney(19.99, 19.99, 19.99)).toBe(59.97);
  });
});

describe('parsePercentOr (IVA de artículos, P1-17)', () => {
  it('un 0 % escrito a propósito se respeta (antes `|| 21` lo convertía en 21 %)', () => {
    expect(parsePercentOr('0', 21)).toBe(0);
    expect(parsePercentOr(0, 21)).toBe(0);
    expect(parsePercentOr('0,0', 21)).toBe(0);
  });
  it('vacío, ausente o no válido cae al valor por defecto', () => {
    for (const raw of ['', '   ', null, undefined, 'abc', '-5', '101']) expect(parsePercentOr(raw, 21)).toBe(21);
  });
  it('acepta coma y punto decimal y valores normales', () => {
    expect(parsePercentOr('10', 21)).toBe(10);
    expect(parsePercentOr('4,5', 21)).toBe(4.5);
    expect(parsePercentOr('7.5', 21)).toBe(7.5);
    expect(parsePercentOr(100, 21)).toBe(100);
  });
});
