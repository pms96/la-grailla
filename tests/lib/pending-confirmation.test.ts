import { describe, expect, it } from 'vitest';
import { UNCONFIRMED_ORDER_TTL_MS, parseUnconfirmedOrder, pendingNotice } from '@/lib/confirmation-state';

describe('pendingNotice (H-100)', () => {
  it('mientras sondea, el texto de siempre con spinner y sin botón', () => {
    expect(pendingNotice({ pollsExhausted: false, ref: 'AB12CD34' })).toMatchObject({ title: 'Confirmando el pago…', detail: expect.stringContaining('confirmación de la pasarela'), spinner: true, offerRecheck: false });
  });

  it('agotado el sondeo: dice que NO repita el pago, da la referencia y ofrece comprobar de nuevo (sin spinner mudo)', () => {
    const n = pendingNotice({ pollsExhausted: true, ref: 'AB12CD34' });
    expect(n.spinner).toBe(false);
    expect(n.offerRecheck).toBe(true);
    expect(n.detail).toMatch(/NO vuelvas a pagar/);
    expect(n.detail).toContain('AB12CD34');
    expect(n.detail).toMatch(/volver al carrito/);
  });
});

describe('parseUnconfirmedOrder (H-100)', () => {
  const now = 1_800_000_000_000;
  const raw = (over: object = {}) => JSON.stringify({ orderId: 'ord1', token: 'tok', at: now - 1000, ...over });

  it('un pedido reciente se lee con su enlace', () => {
    expect(parseUnconfirmedOrder(raw(), now)).toEqual({ orderId: 'ord1', token: 'tok', at: now - 1000 });
  });

  it('caduca al día: ya no se avisa de un pedido de hace dos días', () => {
    expect(parseUnconfirmedOrder(raw({ at: now - UNCONFIRMED_ORDER_TTL_MS - 1 }), now)).toBeNull();
    expect(parseUnconfirmedOrder(raw({ at: now - UNCONFIRMED_ORDER_TTL_MS + 1000 }), now)).not.toBeNull();
  });

  it('lo estropeado o vacío es null, nunca lanza', () => {
    for (const bad of [null, undefined, '', 'no es json', '{}', raw({ orderId: '' }), raw({ orderId: 5 }), raw({ at: 'ayer' }), 'null']) expect(parseUnconfirmedOrder(bad as string, now)).toBeNull();
  });

  it('una fecha en el futuro (reloj raro) se descarta', () => {
    expect(parseUnconfirmedOrder(raw({ at: now + 10 * 60_000 }), now)).toBeNull();
  });

  it('sin token sigue valiendo (solo se pierde el enlace directo)', () => {
    expect(parseUnconfirmedOrder(JSON.stringify({ orderId: 'o', at: now }), now)).toEqual({ orderId: 'o', at: now });
  });
});
