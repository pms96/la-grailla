import { describe, expect, it } from 'vitest';
import { sameShopOrderRequest, sameTicketOrderRequest } from '@/lib/idempotency-match';

/* H-214: la clave de idempotencia solo debe reconocer «el mismo intento». Si el comprador volvió atrás desde la pasarela y cambió la selección, el pedido que ya
 * existe NO es lo que pide ahora. */

const ticketOrder = { eventId: 'ev1', buyerEmail: 'Ana@Example.com', tickets: [{ ticketTypeId: 'a' }, { ticketTypeId: 'a' }, { ticketTypeId: 'b' }] };

describe('sameTicketOrderRequest', () => {
  it('el mismo evento, email y cantidades por tipo (en cualquier orden y con líneas repetidas) es el mismo intento', () => {
    expect(sameTicketOrderRequest(ticketOrder, { eventId: 'ev1', buyerEmail: ' ana@example.com ', items: [{ ticketTypeId: 'b', quantity: 1 }, { ticketTypeId: 'a', quantity: 1 }, { ticketTypeId: 'a', quantity: 1 }] })).toBe(true);
  });
  it('una línea con cantidad > 1 es lo mismo que esas entradas sueltas, y una petición con una línea de MÁS no es el mismo intento', () => {
    expect(sameTicketOrderRequest(ticketOrder, { eventId: 'ev1', buyerEmail: 'ana@example.com', items: [{ ticketTypeId: 'a', quantity: 2 }, { ticketTypeId: 'b', quantity: 1 }] })).toBe(true);
    expect(sameTicketOrderRequest({ ...ticketOrder, tickets: [{ ticketTypeId: 'a' }, { ticketTypeId: 'a' }] }, { eventId: 'ev1', buyerEmail: 'ana@example.com', items: [{ ticketTypeId: 'a', quantity: 2 }, { ticketTypeId: 'c', quantity: 1 }] })).toBe(false);
  });
  it('otra cantidad, otro tipo, otro evento u otro email no lo es', () => {
    expect(sameTicketOrderRequest(ticketOrder, { eventId: 'ev1', buyerEmail: 'ana@example.com', items: [{ ticketTypeId: 'a', quantity: 3 }, { ticketTypeId: 'b', quantity: 1 }] })).toBe(false);
    expect(sameTicketOrderRequest(ticketOrder, { eventId: 'ev1', buyerEmail: 'ana@example.com', items: [{ ticketTypeId: 'a', quantity: 2 }] })).toBe(false);
    expect(sameTicketOrderRequest(ticketOrder, { eventId: 'ev1', buyerEmail: 'ana@example.com', items: [{ ticketTypeId: 'a', quantity: 2 }, { ticketTypeId: 'c', quantity: 1 }] })).toBe(false);
    expect(sameTicketOrderRequest(ticketOrder, { eventId: 'ev2', buyerEmail: 'ana@example.com', items: [{ ticketTypeId: 'a', quantity: 2 }, { ticketTypeId: 'b', quantity: 1 }] })).toBe(false);
    expect(sameTicketOrderRequest(ticketOrder, { eventId: 'ev1', buyerEmail: 'otra@example.com', items: [{ ticketTypeId: 'a', quantity: 2 }, { ticketTypeId: 'b', quantity: 1 }] })).toBe(false);
  });
});

const shopOrder = {
  buyerEmail: 'luis@example.com',
  items: [
    { productId: 'p1', size: 'M', color: 'Negro', quantity: 2 },
    { productId: 'p2', size: null, color: null, quantity: 1 },
  ],
};

describe('sameShopOrderRequest', () => {
  it('mismas líneas (variante incluida; sin talla ni color da igual null que vacío) es el mismo intento', () => {
    expect(
      sameShopOrderRequest(shopOrder, { buyerEmail: 'LUIS@example.com', items: [{ productId: 'p2', quantity: 1 }, { productId: 'p1', size: 'M', color: 'Negro', quantity: 2 }] })
    ).toBe(true);
  });
  it('otra cantidad, otra talla, otro producto u otro email no lo es', () => {
    expect(sameShopOrderRequest(shopOrder, { buyerEmail: 'luis@example.com', items: [{ productId: 'p1', size: 'M', color: 'Negro', quantity: 3 }, { productId: 'p2', quantity: 1 }] })).toBe(false);
    expect(sameShopOrderRequest(shopOrder, { buyerEmail: 'luis@example.com', items: [{ productId: 'p1', size: 'L', color: 'Negro', quantity: 2 }, { productId: 'p2', quantity: 1 }] })).toBe(false);
    expect(sameShopOrderRequest(shopOrder, { buyerEmail: 'luis@example.com', items: [{ productId: 'p1', size: 'M', color: 'Negro', quantity: 2 }] })).toBe(false);
    expect(sameShopOrderRequest(shopOrder, { buyerEmail: 'otro@example.com', items: [{ productId: 'p1', size: 'M', color: 'Negro', quantity: 2 }, { productId: 'p2', quantity: 1 }] })).toBe(false);
  });
});
