import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUnconfirmedTicketOrder, readUnconfirmedTicketOrder, rememberUnconfirmedTicketOrder } from '@/lib/unconfirmed-ticket-order';
import { UNCONFIRMED_ORDER_KEY } from '@/lib/confirmation-state';

/* H-229: la protección anti-recompra de H-100 (recordar un pedido sin confirmar y avisar en el checkout) solo existía en la tienda. En entradas, con el pedido PENDING y el sondeo
 * agotado, el texto decía «Puedes cerrar esta página» y quien reabría `/comprar` (clave nueva) compraba otra vez. Mismo mecanismo, con su propia clave y el evento. */

function fakeStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
}

let storage: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('window', { localStorage: storage });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pedido de entradas sin confirmar', () => {
  it('se recuerda con su token y su evento, y se lee tal cual', () => {
    rememberUnconfirmedTicketOrder('ord1', 'tok', 'ev1');
    expect(readUnconfirmedTicketOrder()).toMatchObject({ orderId: 'ord1', token: 'tok', eventId: 'ev1' });
  });

  it('se olvida al constar pagado', () => {
    rememberUnconfirmedTicketOrder('ord1', 'tok', 'ev1');
    clearUnconfirmedTicketOrder();
    expect(readUnconfirmedTicketOrder()).toBeNull();
  });

  it('caduca al día (no avisa de un pedido de ayer)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    rememberUnconfirmedTicketOrder('ord1', undefined, 'ev1');
    vi.setSystemTime(new Date('2026-11-02T11:00:00Z'));
    expect(readUnconfirmedTicketOrder()).toBeNull();
  });

  it('no pisa ni borra lo que recuerda la TIENDA (clave aparte)', () => {
    storage.setItem(UNCONFIRMED_ORDER_KEY, JSON.stringify({ orderId: 'shop1', at: Date.now() }));
    rememberUnconfirmedTicketOrder('ord1', 'tok', 'ev1');
    clearUnconfirmedTicketOrder();
    expect(storage.getItem(UNCONFIRMED_ORDER_KEY)).toContain('shop1');
  });

  it('sin almacenamiento (modo privado, bloqueado) no lanza', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('blocked');
      },
    });
    expect(() => rememberUnconfirmedTicketOrder('ord1', 'tok', 'ev1')).not.toThrow();
    expect(readUnconfirmedTicketOrder()).toBeNull();
    expect(() => clearUnconfirmedTicketOrder()).not.toThrow();
  });
});
