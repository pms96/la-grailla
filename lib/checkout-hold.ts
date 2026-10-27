/* Retención de un pedido sin pagar (P0-04). Un pedido PENDING reserva aforo/stock desde que se crea; esa reserva dura lo que dura la
 * sesión de pago de la pasarela, y ninguna más. Una sola constante gobierna las dos cosas: la caducidad que se pide a la pasarela al
 * crear la sesión y el momento a partir del cual el cron se plantea liberar el pedido. */

/** Minutos que vive una sesión de pago. 30 es el mínimo que admite Stripe (`expires_at` entre 30 min y 24 h). */
export const CHECKOUT_HOLD_MINUTES = 30;

/** Margen tras la caducidad antes de que el cron libere: cubre el desfase de reloj y el webhook de «sesión expirada», que llega con retraso. */
export const CHECKOUT_RELEASE_GRACE_MINUTES = 10;

/** Edad (ms) desde la que un pedido con pasarela es candidato a liberarse si sigue sin pagar. */
export const CHECKOUT_RELEASE_AFTER_MS = (CHECKOUT_HOLD_MINUTES + CHECKOUT_RELEASE_GRACE_MINUTES) * 60_000;

/** Red de seguridad: un PENDING más viejo que esto SIN `paymentId` (nunca llegó a la pasarela) se libera sin consultar a nadie. */
export const STALE_ORDER_SAFETY_NET_MS = 24 * 60 * 60_000;

/** Instante (ms) en que caduca una sesión creada ahora. */
export function checkoutExpiresAtMs(now: number = Date.now()): number {
  return now + CHECKOUT_HOLD_MINUTES * 60_000;
}

/**
 * Margen que se suma SOLO a `expires_at` de Stripe. Stripe exige que `expires_at` esté al menos 30 minutos después de que ELLA cree la
 * sesión, y la petición tarda en llegar: pidiendo exactamente «ahora + 30 min» desde nuestro reloj, la sesión quedaría a 29 min y 59 s de
 * la creación y Stripe la rechazaría. Un minuto de margen cubre latencia y desfase de reloj; la retención real sigue siendo ~30 min y el
 * cron no libera hasta CHECKOUT_RELEASE_AFTER_MS, que lo deja de sobra por detrás.
 */
export const STRIPE_EXPIRES_AT_MARGIN_SECONDS = 60;

/** `expires_at` de Stripe: segundos UNIX. */
export function stripeExpiresAt(now: number = Date.now()): number {
  return Math.floor(checkoutExpiresAtMs(now) / 1000) + STRIPE_EXPIRES_AT_MARGIN_SECONDS;
}

/** `valid_until` de SumUp: fecha-hora ISO 8601 en UTC (formato `date-time` de su API). */
export function sumUpValidUntil(now: number = Date.now()): string {
  return new Date(checkoutExpiresAtMs(now)).toISOString();
}

/** ¿Un pedido creado en `createdAt` ya superó el plazo en que debería haberse pagado (retención + margen)? */
export function isPastReleaseDeadline(createdAt: Date, now: number = Date.now()): boolean {
  return now - createdAt.getTime() >= CHECKOUT_RELEASE_AFTER_MS;
}
