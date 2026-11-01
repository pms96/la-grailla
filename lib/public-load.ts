import { errorForLog } from '@/lib/api-error';

/* H-104: carga de datos de las páginas públicas que el CDN de Vercel guarda 60-90 s POR DOMINIO (next.config.js: `Vercel-CDN-Cache-Control`).
 *
 * Antes, si la BD fallaba, la página atrapaba el error y pintaba «No hemos podido cargar…» con HTTP 200: el CDN guardaba esa respuesta y la servía a TODOS los
 * visitantes hasta 90 s después de que la BD se recuperase. El CDN de Vercel solo guarda 200, 301, 302, 307, 308, 404 y 410: un 5xx no se guarda. Por eso un fallo de
 * carga ahora LANZA (500, sin caché) y lo pinta `app/(public)/error.tsx`.
 *
 * Esto solo da un 500 de verdad si no hay un `loading.tsx` en la ruta: con él, Next envía antes el esqueleto con 200 y el error llega ya dentro del flujo
 * (probado: la ficha de un evento que no existe también salía con 200). Por eso `/eventos` y `/eventos/[slug]` no tienen `loading.tsx`
 * (tests/lib/public-load.test.ts lo vigila para toda ruta con caché de CDN). */

export class PublicLoadError extends Error {
  constructor(what: string) {
    // El mensaje es lo que escribe Next en el log y lo que ve Sentry: sin consulta ni datos de la conexión.
    super(`No se pudo cargar ${what}`);
    this.name = 'PublicLoadError';
  }
}

/**
 * Ejecuta la carga de una página pública. Si falla, registra el motivo (sin la consulta ni los datos) y lanza un `PublicLoadError` con un mensaje fijo:
 * Next la responde con 500, el CDN no la guarda e `instrumentation.ts` la avisa a Sentry.
 */
export async function loadOrFail<T>(what: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error(`[${what}] Error al cargar:`, errorForLog(error));
    throw new PublicLoadError(what);
  }
}
