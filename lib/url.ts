/* Deriva la URL base pública (protocolo + host) a partir de la propia request en
 * curso, en vez de depender de NEXTAUTH_URL. Un valor fijo en .env solo es
 * correcto para UN entorno (local, o UN dominio de producción) — en cuanto la
 * app se sirve desde otro host/puerto (otro deploy, preview, dominio custom),
 * cualquier redirect_url construido con ese valor apunta al sitio equivocado.
 * Los headers x-forwarded-* son los que pone el proxy/CDN delante de Next.js
 * con el host y protocolo REALES por los que entró la petición. */
export function getBaseUrl(request: Request): string {
  const headers = request.headers;
  const host = headers.get('x-forwarded-host') || headers.get('host');
  if (host) {
    const proto = headers.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  // Sin request (p. ej. un job en background): recurrir a la config fija.
  return process.env.NEXTAUTH_URL ?? '';
}
