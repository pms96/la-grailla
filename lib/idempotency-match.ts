/* H-214: la clave de idempotencia la genera el navegador para UN intento de compra. Si el comprador vuelve atrás desde la pasarela, cambia la selección y paga de nuevo,
 * la clave sigue siendo la misma: reconocerla sin comparar nada devolvía el pedido ANTIGUO (y se pagaba lo que ya no quería). Estas funciones dicen si la petición nueva
 * es de verdad el mismo intento; si no lo es, la ruta responde 409 `idempotency_mismatch` y el navegador pide otra clave. */

export const IDEMPOTENCY_MISMATCH = {
  error: 'Has cambiado tu selección desde el último intento de pago. Revísala y vuelve a pulsar «Ir a pagar».',
  code: 'idempotency_mismatch',
} as const;

const email = (value: string) => value.trim().toLowerCase();

/** Mapa «línea → unidades» comparable sin importar el orden ni que una misma línea venga repetida. */
function tally(entries: Iterable<[string, number]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, qty] of entries) out.set(key, (out.get(key) ?? 0) + qty);
  return out;
}

function sameTally(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, qty] of a) if (b.get(key) !== qty) return false;
  return true;
}

export function sameTicketOrderRequest(
  existing: { eventId: string; buyerEmail: string; tickets: { ticketTypeId: string | null }[] },
  request: { eventId: string; buyerEmail: string; items: { ticketTypeId: string; quantity: number }[] }
): boolean {
  if (existing.eventId !== request.eventId || email(existing.buyerEmail) !== email(request.buyerEmail)) return false;
  return sameTally(
    tally(existing.tickets.map((t): [string, number] => [t.ticketTypeId ?? '', 1])),
    tally(request.items.map((i): [string, number] => [i.ticketTypeId, i.quantity]))
  );
}

// La cantidad es opcional en la petición de tienda (vale 1): se cuenta igual que la cuenta el servidor.
type ShopLine = { productId: string; size?: string | null; color?: string | null; quantity?: number };
const shopKey = (l: ShopLine) => `${l.productId}\0${l.size ?? ''}\0${l.color ?? ''}`;

export function sameShopOrderRequest(existing: { buyerEmail: string; items: ShopLine[] }, request: { buyerEmail: string; items: ShopLine[] }): boolean {
  if (email(existing.buyerEmail) !== email(request.buyerEmail)) return false;
  return sameTally(
    tally(existing.items.map((l): [string, number] => [shopKey(l), l.quantity ?? 1])),
    tally(request.items.map((l): [string, number] => [shopKey(l), l.quantity ?? 1]))
  );
}
