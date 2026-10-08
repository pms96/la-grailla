import { requireTenant } from './context';
import { isPlatformMode } from './mode';

/**
 * Prefijo de Blob de un cliente: `{tenantId}/` en modo plataforma (el almacén es compartido y así se atribuye y se puede
 * borrar por cliente) y vacío en modo normal (las rutas de siempre). Lo impone el servidor; nunca viene del cliente.
 * Las subidas directas del navegador (@vercel/blob/client) eligen la ruta en el cliente y se validan contra la BD del cliente:
 * llevarlas al prefijo es parte del trabajo de branding (M6).
 */
export function tenantBlobPrefix(): string {
  return isPlatformMode() ? `${requireTenant().tenantId}/` : '';
}
