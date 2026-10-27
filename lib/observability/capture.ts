import { currentTenant } from '@/lib/tenant/context';
import { truncateId } from './scrub';

/* Punto de entrada para avisar de un error a Sentry desde el código de dinero (handleApiError, webhooks, reconcile). INERTE sin `SENTRY_DSN`:
 * no se importa el SDK ni se hace nada (el comportamiento es idéntico al de antes). Con DSN, el SDK se carga con import dinámico, así que ni
 * siquiera entra en memoria en una instalación que no lo usa.
 *
 * Contexto mínimo por diseño: ruta (patrón), proveedor, tipo (`entradas`/`tienda`), motivo y el id de pedido TRUNCADO a 8 caracteres.
 * NUNCA se pasan aquí datos del comprador (nombre, email, teléfono, importes): el filtro de scrub.ts es la segunda barrera, no la primera.
 * Nunca lanza ni espera: el aviso sale en segundo plano y un fallo del SDK no cambia la respuesta al comprador. */

export type OpsErrorContext = {
  /** Patrón de ruta, p. ej. `POST /api/webhooks/stripe` (no la URL real). */
  route?: string;
  orderId?: string;
  provider?: string;
  kind?: 'entradas' | 'tienda' | string;
  /** Motivo corto en snake_case. */
  reason?: string;
};

export const sentryEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !!env.SENTRY_DSN?.trim();

/** Id del cliente de la petición en curso, o null si no hay contexto (jobs, scripts, instalación única) o no se puede leer. No lanza. */
export function safeTenantId(): string | null {
  try {
    return currentTenant()?.tenantId ?? null;
  } catch {
    return null;
  }
}

/** Contexto saneado: solo campos conocidos, cadenas cortas y el pedido truncado. */
export function minimalContext(ctx: OpsErrorContext): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown, max: number) => {
    if (typeof v === 'string' && v) out[k] = v.slice(0, max);
  };
  put('route', ctx.route, 120);
  put('provider', ctx.provider, 40);
  put('kind', ctx.kind, 40);
  put('reason', ctx.reason, 80);
  const order = truncateId(ctx.orderId);
  if (order) out.order = order;
  return out;
}

/** Avisa de un error inesperado (5xx, fallo de reconcile). No hace nada sin DSN. Nunca lanza. */
export function captureOpsError(error: unknown, ctx: OpsErrorContext = {}): void {
  if (!sentryEnabled()) return;
  try {
    const tenant = safeTenantId(); // se lee AQUÍ, dentro de la petición: más tarde el contexto ya no existe
    const tags = minimalContext(ctx);
    void import('./sentry-server')
      .then((m) => m.captureOps(error, tags, tenant))
      .catch(() => undefined);
  } catch {
    // el aviso es accesorio
  }
}
