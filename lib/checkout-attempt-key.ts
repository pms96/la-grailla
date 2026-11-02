/* H-214 (cliente): la clave de idempotencia identifica UN intento de compra. Se conserva mientras el comprador no cambie lo que compra (un reintento tras un fallo de red o un
 * doble clic no puede cobrar dos veces) y se renueva en cuanto cambia la selección o el email (tras «atrás» desde la pasarela la página vuelve con su estado, y reutilizar la
 * clave devolvía el pedido anterior). La huella usa los mismos criterios que `lib/idempotency-match.ts`, que es quien decide en el servidor. */

export type CheckoutAttempt = { key: string; fingerprint: string };

export function attemptKey(current: CheckoutAttempt | null, fingerprint: string, newId: () => string = () => crypto.randomUUID()): CheckoutAttempt {
  if (current && current.fingerprint === fingerprint) return current;
  return { key: newId(), fingerprint };
}

const email = (value: string) => value.trim().toLowerCase();

export function ticketAttemptFingerprint(eventId: string, buyerEmail: string, items: { ticketTypeId: string; quantity: number }[]): string {
  const lines = items.map((i) => `${i.ticketTypeId}:${i.quantity}`).sort();
  return JSON.stringify([eventId, email(buyerEmail), lines]);
}

export function shopAttemptFingerprint(buyerEmail: string, items: { productId: string; quantity: number; size?: string | null; color?: string | null }[]): string {
  const lines = items.map((l) => `${l.productId}:${l.size ?? ''}:${l.color ?? ''}:${l.quantity}`).sort();
  return JSON.stringify([email(buyerEmail), lines]);
}
