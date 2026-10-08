/* Validación de URLs de Vercel Blob que llegan del navegador.
 *
 * Antes se comprobaba con `url.includes('/sponsors/<id>/')`: una subcadena
 * sobre una URL que controla el cliente. Cualquier host, o la subcadena en el
 * query string, la daba por buena — y esa URL se guardaba y luego se pasaba a
 * `del()`. Aquí se parsea con `new URL` y se exige host de Blob, https, sin
 * query ni credenciales, y que la RUTA empiece por el prefijo esperado. */

const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';

export function parseBlobUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!url.hostname.endsWith(BLOB_HOST_SUFFIX) || url.hostname.length === BLOB_HOST_SUFFIX.length) return null;
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
