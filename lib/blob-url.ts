/* Validación de URLs de Vercel Blob que llegan del navegador.
 *
 * Antes se comprobaba con `url.includes('/sponsors/<id>/')`: una subcadena
 * sobre una URL que controla el cliente. Cualquier host, o la subcadena en el
 * query string, la daba por buena — y esa URL se guardaba y luego se pasaba a
 * `del()`. Aquí se parsea con `new URL` y se exige host de Blob, https, sin
 * query ni credenciales, y que la RUTA empiece por el prefijo esperado. */

const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';

/**
 * ¿Es este hostname un almacén de Blob admisible? Con `BLOB_PUBLIC_HOST` definida (el almacén de la plataforma) solo ese host exacto: otro almacén de
 * Blob también acaba en el mismo sufijo y aceptarlo permitía apuntar logos, carteles y borrados a un almacén ajeno (H-067). Sin la variable (desarrollo,
 * donde no hay almacén fijo) vale cualquier almacén de Blob. Se lee `process.env.BLOB_PUBLIC_HOST` literal: Next la sustituye en el build.
 */
export function isPlatformBlobHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const platformHost = (process.env.BLOB_PUBLIC_HOST ?? '').trim().toLowerCase();
  if (platformHost) return host === platformHost;
  return host.endsWith(BLOB_HOST_SUFFIX) && host.length > BLOB_HOST_SUFFIX.length;
}

export function parseBlobUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!isPlatformBlobHost(url.hostname)) return null;
  if (url.search || url.hash || url.username || url.password || url.port) return null;
  return url;
}

// `pathPrefix` va sin barra inicial: "sponsors/<id>/" o "sponsors/<id>/final-video/".
export function isBlobUrlUnder(raw: string, pathPrefix: string): boolean {
  const url = parseBlobUrl(raw);
  if (!url) return false;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return false;
  }
  const prefix = `${pathPrefix.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
  return path.startsWith(prefix) && !path.split('/').includes('..');
}

// Solo se borran URLs que de verdad son de Blob: una fila antigua con una URL
// rara no debe acabar en una llamada de borrado con un host que no es el nuestro.
export function isDeletableBlobUrl(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && parseBlobUrl(raw) !== null;
}

// Nombre de archivo seguro para usarlo como último segmento de una ruta de Blob.
export function sanitizeUploadFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
  return cleaned.slice(-100) || 'archivo';
}
