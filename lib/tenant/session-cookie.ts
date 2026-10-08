import { isDevHost } from './dev-host';
import { legacyTenantId } from './mode';

/* Nombre de la cookie de sesión en modo plataforma. Edge-safe: lo usan el middleware (getToken) y las opciones de NextAuth.
 *
 *  - Desarrollo local (`*.localhost`): sin HTTPS, el nombre de siempre.
 *  - Cliente legacy (La Grailla): `__Secure-next-auth.session-token`, el que ya tienen sus sesiones abiertas. Cambiarlo cerraría
 *    la sesión de admins y taquilla en el corte.
 *  - Resto de clientes: `__Host-…`. Ese prefijo obliga a Secure, Path=/ y SIN Domain, así que un subdominio hermano de otro
 *    cliente no puede plantar una cookie con `Domain=` del padre para cerrar o fijar sesiones ("cookie tossing"). */

export const SESSION_COOKIE_DEFAULT = 'next-auth.session-token';
export const SESSION_COOKIE_SECURE = `__Secure-${SESSION_COOKIE_DEFAULT}`;
export const SESSION_COOKIE_HOST = `__Host-${SESSION_COOKIE_DEFAULT}`;

export function sessionCookieName(ctx: { tenantId: string; host: string }): string {
  if (isDevHost(ctx.host)) return SESSION_COOKIE_DEFAULT;
  return legacyTenantId() === ctx.tenantId ? SESSION_COOKIE_SECURE : SESSION_COOKIE_HOST;
}
