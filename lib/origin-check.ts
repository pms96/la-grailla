/* Defensa CSRF para peticiones que modifican datos.
 *
 * Las cookies de sesión de NextAuth son SameSite=Lax, que ya frena la mayoría
 * de los ataques, pero no hay ninguna comprobación de origen en las rutas de
 * API. Este chequeo bloquea una petición mutante cuando el NAVEGADOR dice que
 * viene de otro sitio: cabecera `Origin` de otro host (o "null"), o
 * `Sec-Fetch-Site: cross-site`.
 *
 * Una petición sin `Origin` (curl, el cron de GitHub Actions, el webhook de
 * Stripe, los tests) se deja pasar: no la envía un navegador de un tercero y
 * ya tiene sus propias comprobaciones (secreto, firma). */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Rutas cuyo llamante no es un navegador de la propia web. NextAuth lleva su
// propio token CSRF en /api/auth.
const ORIGIN_CHECK_EXEMPT_PREFIXES = ['/api/webhooks/', '/api/cron/', '/api/auth/'];

export function isOriginCheckExempt(path: string): boolean {
  return ORIGIN_CHECK_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function firstValue(value: string | null): string {
  return (value ?? '').split(',')[0].trim().toLowerCase();
}

export function isCrossOriginMutation(method: string, headers: Headers): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;

  if (firstValue(headers.get('sec-fetch-site')) === 'cross-site') return true;

  const origin = headers.get('origin');
  if (origin === null) return false;
  if (origin === 'null') return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }

  const allowed = [firstValue(headers.get('host')), firstValue(headers.get('x-forwarded-host'))].filter(Boolean);
  return !allowed.includes(originHost);
}
