import { describe, expect, it } from 'vitest';
import { orderLoadOutcome } from '@/lib/order-load';

/* H-220: las pantallas de confirmación trataban CUALQUIER respuesta no correcta como «pedido no encontrado» (tienda) o sustituían una confirmación ya pintada por «no hemos podido
 * cargar» (entradas): un 429 o un 503 transitorio hacía creer a quien acababa de pagar que su pedido se había perdido. Solo un 4xx de «no existe o no es tuyo» lo es. */

describe('orderLoadOutcome', () => {
  it.each([200, 201])('%s: ok', (status) => expect(orderLoadOutcome(status)).toBe('ok'));
  it.each([400, 401, 403, 404, 410])('%s: el pedido no existe (o el enlace no vale)', (status) => expect(orderLoadOutcome(status)).toBe('not_found'));
  it.each([408, 425, 429, 500, 502, 503, 504, 0])('%s: fallo transitorio, el pedido puede existir', (status) => expect(orderLoadOutcome(status)).toBe('transient'));
});
