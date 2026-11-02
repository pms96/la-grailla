import { z } from 'zod';
import { normalizePublicUrl } from '@/lib/safe-url';

/* H-241: la parte de zod de `lib/safe-url.ts`, aparte. `normalizePublicUrl` lo importan componentes de CLIENTE (formulario público de sponsors, ficha del admin); con zod en el mismo
 * módulo, zod entraba en esos bundles del navegador. Este archivo solo lo importan las rutas de servidor. */

const MAX_LENGTH = 300;

/**
 * Campo zod de una web opcional que acaba en un `href`: vacío = `null`; el resto pasa por `normalizePublicUrl` o se rechaza con un mensaje para el usuario.
 * Lo usan las rutas que escriben `SponsorRequest.website` con validación (formulario público y alta manual del admin: H-105, H-169). El portal del sponsor ya no la escribe (H-216).
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
