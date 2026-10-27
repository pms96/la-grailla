import { describe, expect, it } from 'vitest';
import { confirmationView, shouldKeepPolling } from '@/lib/confirmation-state';

/* La decisión de qué dice la pantalla de confirmación (entradas y tienda) es una función pura: «no se ha realizado ningún cargo» solo si la pasarela lo
 * confirma, «estamos comprobando» solo mientras se está comprobando, y un mensaje final claro cuando se agota el sondeo. */
const v = (status: string, over: Partial<Parameters<typeof confirmationView>[0]> = {}) => confirmationView({ status, pollsExhausted: false, ...over });

describe('confirmationView', () => {
  it.each(['COMPLETED', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'])('%s → confirmed', (status) => {
    expect(v(status)).toBe('confirmed');
  });

  it('PENDING → pending; REFUNDED → refunded', () => {
    expect(v('PENDING')).toBe('pending');
    expect(v('REFUNDED')).toBe('refunded');
  });

  describe('CANCELLED', () => {
    it('sin pago asociado: nunca hubo cargo que comprobar → not_charged', () => {
      expect(v('CANCELLED', { paymentId: null })).toBe('not_charged');
      expect(v('CANCELLED', { paymentId: undefined, paymentCheck: 'none' })).toBe('not_charged');
    });

    it('con pago asociado y la pasarela confirmando que NO se pagó → not_charged («no se ha realizado ningún cargo»)', () => {
      expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck: 'not_paid' })).toBe('not_charged');
    });

    it('con pago asociado SIN confirmación (checking, none o ausente) → «comprobando», nunca «no se ha cobrado»', () => {
      for (const paymentCheck of ['checking', 'none', undefined, null] as const) {
        expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck }), String(paymentCheck)).toBe('checking');
      }
    });

    it('agotado el sondeo sin resolverse → mensaje final claro (checking_gave_up), que no afirma que no se cobró', () => {
      expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck: 'checking', pollsExhausted: true })).toBe('checking_gave_up');
    });

    it('si la pasarela confirma el no-pago, agotar el sondeo no lo cambia', () => {
      expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck: 'not_paid', pollsExhausted: true })).toBe('not_charged');
    });

    it('cobro devuelto → refunded', () => {
      expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck: 'refunded' })).toBe('refunded');
    });
  });

  it('solo se sigue sondeando mientras el resultado pueda cambiar', () => {
    expect(shouldKeepPolling('pending')).toBe(true);
    expect(shouldKeepPolling('checking')).toBe(true);
    for (const view of ['confirmed', 'checking_gave_up', 'not_charged', 'refunded'] as const) expect(shouldKeepPolling(view), view).toBe(false);
  });
});
