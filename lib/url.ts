/* Deriva la URL base pública (protocolo + host) a partir de la propia request en
 * curso, en vez de depender de NEXTAUTH_URL. Un valor fijo en .env solo es
 * correcto para UN entorno (local, o UN dominio de producción) — en cuanto la
 * app se sirve desde otro host/puerto (otro deploy, preview, dominio custom),
 * cualquier redirect_url construido con ese valor apunta al sitio equivocado.
 * Los headers x-forwarded-* son los que pone el proxy/CDN delante de Next.js
 * con el host y protocolo REALES por los que entró la petición.
 *
 * Esa URL acaba en emails con tokens de acceso y en redirects de pago, así que
 * el host se valida: solo hostname[:puerto]. Una cabecera con "/", "@", espacios
 * o saltos de línea (host header injection) se descarta y se usa el valor fijo.
 *
 * Este archivo es el ÚNICO sitio que debe leer NEXTAUTH_URL para construir
 * URLs absolutas (ver getFallbackBaseUrl). Cuando un mismo despliegue sirva a
 * varios clientes, solo hay que cambiar aquí de dónde sale la base. */

const VALID_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

export function isValidHost(host: string): boolean {
  return host.length <= 255 && VALID_HOST.test(host);
}

// Base fija de la instalación, sin barra final. Para código sin request (un
// cron, un job en background) o cuando la request no trae un host fiable.
export function getFallbackBaseUrl(): string {
  return (process.env.NEXTAUTH_URL ?? '').replace(/\/+$/, '');
}

export function getBaseUrl(request: Request): string {
  const headers = request.headers;
  const host = (headers.get('x-forwarded-host') || headers.get('host') || '').split(',')[0].trim();
  if (host && isValidHost(host)) {
    const forwardedProto = (headers.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
    const isLocal = host.startsWith('localhost') || host.startsWith('127.');
    const proto = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : isLocal ? 'http' : 'https';
    return `${proto}://${host}`;
  }
  return getFallbackBaseUrl();
}
