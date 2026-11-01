/* Direcciones web que escribe un visitante y que luego acaban en un `href` de un correo al operador (formulario de sponsors, H-105).
 * Antes el campo era texto libre: `javascript:…`, `data:…` o una cadena con comillas llegaba tal cual al enlace del email. */

const MAX_LENGTH = 300;

/**
 * Devuelve la URL http(s) normalizada, o `null` si no es una dirección web válida.
 *  - Sin esquema («tuempresa.com», «instagram.com/tuempresa») se asume https.
 *  - Cualquier otro esquema (`javascript:`, `data:`, `file:`, `mailto:`…) se rechaza.
 *  - Sin usuario ni contraseña en la URL (`https://banco.com@evil.es` engaña a quien lee el enlace) y con un host con punto.
 */
export function normalizePublicUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > MAX_LENGTH || /[\s<>"'`\\]/.test(text)) return null;
  // «algo:» antes de cualquier `/` es un esquema; «dominio.com:8080/x» (puerto) no lo es.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/]*:\d+(\/|$)/.test(text);
  const candidate = hasScheme ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes('.')) return null;
  return url.toString();
}
