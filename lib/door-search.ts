/* Ayudas de la búsqueda de asistentes en la puerta (`GET /api/access/search`, P1-06). Aparte de la ruta porque un `route.ts` de Next no puede
 * exportar nada que no sea un handler HTTP. */

/** `ab***@dominio.com`: basta para que el asistente confirme que es el suyo sin enseñar el email entero. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

/** Referencia corta del pedido que el comprador puede leer de su email o PDF: los últimos 6 caracteres del id, en mayúsculas. */
export function orderRef(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}
