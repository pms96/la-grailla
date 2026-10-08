import { requireTenant } from './context';
import { isPlatformMode } from './mode';

/**
 * Prefijo de Blob de un cliente: `{tenantId}/` en modo plataforma (el almacén es compartido y así se atribuye y se puede
 * borrar por cliente) y vacío en modo normal (las rutas de siempre). Lo impone el servidor; nunca viene del cliente.
 * Las subidas directas del navegador (@vercel/blob/client) eligen la ruta en el cliente: reciben el prefijo en el contexto de marca
 * (`useBrand().blobPrefix`) y el servidor exige que la ruta lo lleve (lib/sponsor-uploads.ts).
 */
export function tenantBlobPrefix(): string {
  return isPlatformMode() ? `${requireTenant().tenantId}/` : '';
}
