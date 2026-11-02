import { z } from 'zod';

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

/**
 * Campo zod de una web opcional que acaba en un `href`: vacío = `null`; el resto pasa por `normalizePublicUrl` o se rechaza con un mensaje para el usuario.
 * Lo usan TODAS las rutas que escriben `SponsorRequest.website` (formulario público, alta manual del admin y portal del sponsor: H-105, H-169).
 */
export const optionalPublicUrl = z
  .string()
  .max(MAX_LENGTH)
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v == null || v.trim() === '') return null;
    const url = normalizePublicUrl(v);
    if (!url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Escribe una dirección web válida (por ejemplo https://tuempresa.com)' });
      return z.NEVER;
    }
    return url;
  });
